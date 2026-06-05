/**
 * Phase 12h — Staff API POST /staff/bot/booking-dry-run smoke proof.
 *
 * Usage:
 *   LUNA_BOT_INTERNAL_TOKEN=<secret> STAFF_API_BASE_URL=https://staff-staging.lunafrontdesk.com \
 *     npm run proof:luna-booking-dry-run-route
 *
 * Local (open auth when STAFF_AUTH_REQUIRED is not true):
 *   npm run staff:api
 *   npm run proof:luna-booking-dry-run-route
 *
 * Exits 0 on PASS, 1 on failure. Does not write files or print secrets.
 *
 * @module proof-luna-booking-dry-run-route
 */

'use strict';

const http  = require('http');
const https = require('https');
const path  = require('path');
const { URL } = require('url');

require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

const ROUTE = '/staff/bot/booking-dry-run';
const PORT  = process.env.STAFF_QUERY_API_PORT || '3036';
const BASE  = (process.env.STAFF_API_BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const TOKEN = process.env.LUNA_BOT_INTERNAL_TOKEN || '';

const PAYLOAD = {
  client_slug: 'wolfhouse-somo',
  channel: 'whatsapp',
  from: '+15555550123',
  guest_name: 'Route Proof Guest',
  language: 'en',
  message_text: 'Hi, I want to stay June 15 to June 22 for 2 people. What packages are available?',
  check_in: '2026-06-15',
  check_out: '2026-06-22',
  guests: 2,
  package_code: 'malibu',
};

const SAFETY_ASSERTIONS = [
  ['dry_run', (v) => v === true],
  ['preview_only', (v) => v === true],
  ['no_write_performed', (v) => v === true],
  ['creates_booking', (v) => v === false],
  ['creates_payment', (v) => v === false],
  ['creates_stripe_link', (v) => v === false],
  ['sends_whatsapp', (v) => v === false],
  ['calls_n8n', (v) => v === false],
  ['planned_actions', (v) => Array.isArray(v) && v.length > 0],
  ['reply_draft', (v) => typeof v === 'string' && v.length > 0],
  ['next_action', (v) => v != null && v !== ''],
];

function postJson(urlStr, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = JSON.stringify(body);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers,
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch { /* keep string */ }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function redactBase(urlStr) {
  try {
    const u = new URL(urlStr);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '(invalid-base-url)';
  }
}

async function main() {
  const target = `${BASE}${ROUTE}`;
  const headers = {};
  if (TOKEN) headers['X-Luna-Bot-Token'] = TOKEN;

  console.log(`POST ${redactBase(BASE)}${ROUTE}`);
  if (!TOKEN) {
    console.log('note: bot auth env not set — relying on open local auth if enabled');
  }

  let res;
  try {
    res = await postJson(target, PAYLOAD, headers);
  } catch (e) {
    console.error('FAIL — request error:', e.message);
    process.exit(1);
  }

  if (res.status !== 200) {
    const err = typeof res.body === 'object' ? res.body.error : res.raw;
    console.error(`FAIL — HTTP ${res.status}${err ? `: ${err}` : ''}`);
    if (res.status === 401 && !TOKEN) {
      console.error('hint: set bot auth env var for staging/authenticated hosts');
    }
    process.exit(1);
  }

  const body = res.body;
  if (!body || typeof body !== 'object') {
    console.error('FAIL — non-JSON response');
    process.exit(1);
  }

  const failures = [];
  for (const [field, check] of SAFETY_ASSERTIONS) {
    if (!check(body[field])) {
      failures.push(`${field} (got ${JSON.stringify(body[field])})`);
    }
  }

  if (body.success === false) {
    failures.push(`success:false error=${body.error || 'unknown'}`);
  }

  if (failures.length) {
    console.error('FAIL — safety assertions:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('PASS — Luna booking dry-run route');
  console.log(`  base: ${redactBase(BASE)}`);
  console.log(`  route: ${ROUTE}`);
  console.log(`  auth_mode: ${body.auth_mode || '(none)'}`);
  console.log(`  next_action: ${body.next_action}`);
  console.log(`  planned_actions: ${JSON.stringify(body.planned_actions)}`);
  console.log(`  reply_draft: ${String(body.reply_draft).slice(0, 120)}${body.reply_draft.length > 120 ? '…' : ''}`);
  console.log('  safety: dry_run preview_only no_write creates_* false sends_whatsapp false calls_n8n false');
}

main().catch((e) => {
  console.error('FAIL —', e.message);
  process.exit(1);
});
