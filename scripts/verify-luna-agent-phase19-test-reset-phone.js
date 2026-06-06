/**
 * Phase 19g.11a — Verifier for staging Luna test phone reset route + UI.
 *
 * Usage:
 *   npm run verify:luna-agent-phase19-test-reset-phone
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API_FILE = path.join(__dirname, 'staff-query-api.js');
const HELPER = path.join(__dirname, 'lib', 'luna-test-reset-phone.js');
const PKG_FILE = path.join(ROOT, 'package.json');

const DOWNSTREAM = [
  'verify:luna-agent-phase19-message-events-read',
  'verify:luna-agent-phase19-message-events-ui',
  'verify:luna-agent-phase19-meta-whatsapp-webhook',
];

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-luna-agent-phase19-test-reset-phone.js  (Phase 19g.11a)\n');

try {
  execSync(`node --check "${API_FILE}"`, { stdio: 'pipe' });
  pass('0', 'staff-query-api.js passes node --check');
} catch {
  fail('0', 'staff-query-api.js syntax error');
}

try {
  execSync(`node --check "${HELPER}"`, { stdio: 'pipe' });
  pass('0b', 'luna-test-reset-phone.js passes node --check');
} catch {
  fail('0b', 'luna-test-reset-phone.js syntax error');
}

const src = fs.readFileSync(API_FILE, 'utf8');
const helperSrc = fs.readFileSync(HELPER, 'utf8');
const htmlMatch = src.match(/function buildUiHtml\(port\)\s*\{([\s\S]*?)^function handleUI/m);
const htmlSrc = htmlMatch ? htmlMatch[1] : src;
const mePanel = htmlSrc.match(/id="msg-events-panel"[\s\S]{0,2800}/);
const mePanelHtml = mePanel ? mePanel[0] : '';
const meJs = src.match(/function buildMessageEventsUrl\(\)[\s\S]*?function resetTestPhoneFromPanel\(\)[\s\S]*?\n\}/);
const meJsSrc = meJs ? meJs[0] : '';

const {
  normalizeResetPhone,
  isStagingResetEnvironment,
  parseResetLunaPhoneInput,
  resetLunaPhoneTestRows,
} = require('./lib/luna-test-reset-phone');

section('A. Route + handler wiring');

if (src.includes('/staff/test/reset-luna-phone')) pass('A1', 'route path registered');
else fail('A1', 'route path missing');

if (src.includes('handleTestResetLunaPhone')) pass('A2', 'handler present');
else fail('A2', 'handler missing');

if (/requireAuth\(req, res, 'operator'\)[\s\S]{0,120}handleTestResetLunaPhone/.test(src)
  || /reset-luna-phone[\s\S]{0,400}requireAuth\(req, res, 'operator'\)/.test(src)) {
  pass('A3', 'operator session auth required');
} else fail('A3', 'operator auth missing');

if (src.includes('isStagingResetEnvironment')) pass('A4', 'staging guard wired in handler');
else fail('A4', 'staging guard missing');

section('B. Helper — staging guard + parsing');

if (isStagingResetEnvironment({ NODE_ENV: 'staging' })) pass('B1', 'NODE_ENV=staging allowed');
else fail('B1', 'staging env not allowed');

if (!isStagingResetEnvironment({ NODE_ENV: 'production' })) pass('B2', 'production blocked');
else fail('B2', 'production not blocked');

if (isStagingResetEnvironment({ NODE_ENV: 'development' }, 'localhost:3036')) pass('B3', 'localhost allowed');
else fail('B3', 'localhost not allowed');

if (normalizeResetPhone('+491 726-422 307') === '491726422307') pass('B4', 'normalizes phone');
else fail('B4', 'phone normalization failed');

const badPhone = parseResetLunaPhoneInput({ client_slug: 'wolfhouse-somo', phone: '' });
if (!badPhone.ok && badPhone.error.includes('phone')) pass('B5', 'requires phone');
else fail('B5', 'phone required check failed');

const badClient = parseResetLunaPhoneInput({ client_slug: 'other', phone: '491726422307' });
if (!badClient.ok && badClient.status === 403) pass('B6', 'client_slug restricted to wolfhouse-somo');
else fail('B6', 'client_slug guard failed');

section('C. Delete behavior (mock pg)');

(async () => {
  const events = [
    { id: 'e1', client_slug: 'wolfhouse-somo', from_phone: '+491726422307' },
    { id: 'e2', client_slug: 'wolfhouse-somo', from_phone: '491726422307' },
    { id: 'e3', client_slug: 'wolfhouse-somo', from_phone: '15555550101' },
    { id: 'e4', client_slug: 'other-client', from_phone: '491726422307' },
  ];
  const sends = [
    { id: 's1', client_slug: 'wolfhouse-somo', to_phone: '491726422307' },
    { id: 's2', client_slug: 'wolfhouse-somo', to_phone: '15555550101' },
    { id: 's3', client_slug: 'other-client', to_phone: '491726422307' },
  ];

  const pg = {
    async query(sql, params) {
      const s = String(sql);
      if (s.includes('DELETE FROM guest_message_events')) {
        const client = params[0];
        const like = params[1].replace(/%/g, '');
        const kept = events.filter((row) => !(
          row.client_slug === client
          && String(row.from_phone || '').replace(/^\+/, '').includes(like)
        ));
        const deleted = events.length - kept.length;
        events.length = 0;
        events.push(...kept);
        return { rowCount: deleted, rows: [] };
      }
      if (s.includes('DELETE FROM guest_message_sends')) {
        const client = params[0];
        const like = params[1].replace(/%/g, '');
        const kept = sends.filter((row) => !(
          row.client_slug === client
          && String(row.to_phone || '').replace(/^\+/, '').includes(like)
        ));
        const deleted = sends.length - kept.length;
        sends.length = 0;
        sends.push(...kept);
        return { rowCount: deleted, rows: [] };
      }
      throw new Error('unexpected query: ' + s.slice(0, 60));
    },
  };

  try {
    const parsed = parseResetLunaPhoneInput({
      client_slug: 'wolfhouse-somo',
      phone: '491726422307',
    });
    const out = await resetLunaPhoneTestRows(pg, parsed.input);

    if (out.deleted.guest_message_events === 2) pass('C1', 'deletes matching guest_message_events only');
    else fail('C1', `events deleted=${out.deleted.guest_message_events}, expected 2`);

    if (out.deleted.guest_message_sends === 1) pass('C2', 'deletes matching guest_message_sends only');
    else fail('C2', `sends deleted=${out.deleted.guest_message_sends}, expected 1`);

    const eventIds = events.map((r) => r.id).sort();
    if (eventIds.length === 2 && eventIds[0] === 'e3' && eventIds[1] === 'e4') {
      pass('C3', 'preserves other phone and other-client rows');
    } else fail('C3', `other phone rows not preserved: ${eventIds.join(',')}`);

    const sendIds = sends.map((r) => r.id).sort();
    if (sendIds.length === 2 && sendIds[0] === 's2' && sendIds[1] === 's3') {
      pass('C4', 'preserves other send phone and other-client rows');
    } else fail('C4', `other send rows not preserved: ${sendIds.join(',')}`);
  } catch (e) {
    fail('C.mock', e.message);
  }

  section('D. Safety — no external writes/calls');

  if (!/graph\.facebook\.com/.test(helperSrc + (src.match(/handleTestResetLunaPhone[\s\S]*?\n\}/)?.[0] || ''))) {
    pass('D1', 'no Graph API in reset path');
  } else fail('D1', 'Graph API found');

  if (!/api\.stripe\.com/.test(helperSrc)) pass('D2', 'no Stripe');
  else fail('D2', 'Stripe found');

  if (!/DELETE FROM bookings|DELETE FROM payments/.test(helperSrc)) pass('D3', 'does not delete bookings/payments');
  else fail('D3', 'bookings/payments delete found');

  if (!/n8n/i.test(helperSrc)) pass('D4', 'no n8n in helper');
  else fail('D4', 'n8n in helper');

  if (helperSrc.includes('guest_message_events') && helperSrc.includes('guest_message_sends')) {
    pass('D5', 'helper targets message tables only');
  } else fail('D5', 'unexpected delete targets');

  section('E. UI — Message Events reset button');

  if (mePanelHtml.includes('id="me-reset-phone"')) pass('E1', 'reset button in panel');
  else fail('E1', 'reset button missing');

  if (/Reset test phone/.test(mePanelHtml)) pass('E2', 'reset button label');
  else fail('E2', 'reset label missing');

  if (meJsSrc.includes('/staff/test/reset-luna-phone')) pass('E3', 'UI calls reset route');
  else fail('E3', 'UI reset fetch missing');

  if (meJsSrc.includes('me-filter-phone') && meJsSrc.includes('Enter a phone number first')) {
    pass('E4', 'UI uses from_phone filter value');
  } else fail('E4', 'from_phone wiring missing');

  if (meJsSrc.includes('confirm(') && meJsSrc.includes('Reset test rows for')) {
    pass('E5', 'UI confirms before reset');
  } else fail('E5', 'confirm dialog missing');

  if (meJsSrc.includes('loadMessageEvents()') && meJsSrc.includes('Reset complete')) {
    pass('E6', 'UI refreshes message events after success');
  } else fail('E6', 'refresh after reset missing');

  if (meJsSrc.includes('staging') && meJsSrc.includes('me-reset-phone')) {
    pass('E7', 'reset button staging-only visibility');
  } else fail('E7', 'staging-only UI guard missing');

  if (!/guest-reply-send|Send WhatsApp|id="me-send"/.test(meJsSrc + mePanelHtml)) {
    pass('E8', 'no send action in panel');
  } else fail('E8', 'send action found');

  section('F. npm script registration');

  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  if (pkg.scripts && pkg.scripts['verify:luna-agent-phase19-test-reset-phone']) {
    pass('F1', 'npm script registered');
  } else fail('F1', 'npm script missing');

  section('G. Downstream verifiers (limited)');

  for (const script of DOWNSTREAM) {
    try {
      execSync(`npm run ${script}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', timeout: 300000 });
      pass('G.' + script, `${script} still passes`);
    } catch (e) {
      fail('G.' + script, `${script} failed`);
      const out = (e.stdout || '') + (e.stderr || '');
      console.error(out.split('\n').slice(-8).join('\n'));
    }
  }

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
