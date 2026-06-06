/**
 * Phase 23c.1 — Verifier for POST /staff/inbox/handoffs/:id/review
 *
 * Usage:
 *   npm run verify:luna-agent-phase23-handoff-review
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API = path.join(__dirname, 'staff-query-api.js');
const REVIEW_HELPER = path.join(__dirname, 'lib', 'luna-guest-message-event-review.js');
const READ_HELPER = path.join(__dirname, 'lib', 'luna-guest-message-events-read.js');
const PKG = path.join(ROOT, 'package.json');

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

function readOrEmpty(p) {
  try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; }
  catch { return ''; }
}

console.log('\nverify-luna-agent-phase23-handoff-review.js  (Phase 23c.1)\n');

try {
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  pass('0', 'staff-query-api.js passes node --check');
} catch {
  fail('0', 'staff-query-api.js syntax error');
}

try {
  execSync(`node --check "${REVIEW_HELPER}"`, { stdio: 'pipe' });
  pass('0b', 'luna-guest-message-event-review.js passes node --check');
} catch {
  fail('0b', 'review helper syntax error');
}

const apiSrc = readOrEmpty(API);
const reviewSrc = readOrEmpty(REVIEW_HELPER);
const readSrc = readOrEmpty(READ_HELPER);

const handlerStart = apiSrc.indexOf('async function handleInboxHandoffReview(');
const handlerEnd = handlerStart > -1
  ? apiSrc.indexOf('async function handleTestResetLunaPhone(', handlerStart)
  : -1;
const handler = handlerStart > -1 && handlerEnd > handlerStart
  ? apiSrc.slice(handlerStart, handlerEnd)
  : '';

const routeMatch = apiSrc.match(/inboxHandoffReviewMatch[\s\S]{0,500}handleInboxHandoffReview/);
const routeBlock = routeMatch ? routeMatch[0] : '';

const htmlMatch = apiSrc.match(/function buildUiHtml\(port\)\s*\{([\s\S]*?)^function handleUI/m);
const htmlSrc = htmlMatch ? htmlMatch[1] : apiSrc;
const hqJsMatch = apiSrc.match(/function buildHandoffsQueueUrl\(\)[\s\S]*?function wireHandoffsQueuePanel\(\)[\s\S]*?\n\}/);
const hqJs = hqJsMatch ? hqJsMatch[0] : '';

const {
  parseHandoffReviewInput,
  markGuestMessageEventHandoffReviewed,
  isHandoffReviewed,
  formatHandoffReviewSummary,
  REVIEW_SOURCE,
} = require('./lib/luna-guest-message-event-review');

const {
  listGuestMessageHandoffQueue,
  parseHandoffQueueQuery,
} = require('./lib/luna-guest-message-events-read');

section('A. Route + handler wiring');

if (apiSrc.includes('/staff/inbox/handoffs') && apiSrc.includes('/review')) {
  pass('A1', 'review route path registered');
} else fail('A1', 'review route path missing');

if (apiSrc.includes('handleInboxHandoffReview')) pass('A2', 'handler present');
else fail('A2', 'handler missing');

if (/requireAuth\(req, res, 'operator'\)/.test(routeBlock)) {
  pass('A3', 'operator session auth required');
} else fail('A3', 'operator auth missing');

if (handler.includes('markGuestMessageEventHandoffReviewed')) {
  pass('A4', 'handler uses markGuestMessageEventHandoffReviewed');
} else fail('A4', 'review helper wiring missing');

if (!/\bstaff_handoffs\b/.test(handler.replace(/no_staff_handoffs_write/g, ''))
    && !handler.includes('getOpenHandoffsQuery')) {
  pass('A5', 'handler does not touch staff_handoffs');
} else fail('A5', 'handler must not use staff_handoffs');

section('B. Review helper — parse + normalized write');

const parsed = parseHandoffReviewInput({ client_slug: 'wolfhouse-somo', review_note: ' handled ' });
if (parsed.ok && parsed.input.client_slug === 'wolfhouse-somo' && parsed.input.review_note === 'handled') {
  pass('B1', 'parseHandoffReviewInput trims note');
} else fail('B1', 'parseHandoffReviewInput failed');

const summary = formatHandoffReviewSummary({
  reviewed: true,
  reviewed_at: '2026-06-06T12:00:00.000Z',
  reviewed_by: 'op@test.com',
  review_note: null,
  source: REVIEW_SOURCE,
});
if (summary && summary.reviewed === true && summary.source === REVIEW_SOURCE) {
  pass('B2', 'formatHandoffReviewSummary works');
} else fail('B2', 'formatHandoffReviewSummary failed');

if (reviewSrc.includes('UPDATE guest_message_events') && reviewSrc.includes('normalized')) {
  pass('B3', 'helper updates normalized JSON only');
} else fail('B3', 'normalized update missing');

if (!reviewSrc.includes('raw_payload')) {
  pass('B4', 'helper does not touch raw_payload');
} else fail('B4', 'raw_payload mutation risk');

section('C. Idempotency + 404 (mock pg)');

(async () => {
  const EVENT_ID = '11111111-1111-4111-8111-111111111111';
  let storedNorm = { supported: false, message_type: 'image' };

  const pg = {
    query: async (sql, params) => {
      const s = String(sql);
      if (s.includes('SELECT') && s.includes('guest_message_events')) {
        if (params[1] === EVENT_ID) {
          return {
            rows: [{
              id: EVENT_ID,
              client_slug: params[0],
              normalized: storedNorm,
            }],
          };
        }
        return { rows: [] };
      }
      if (s.includes('UPDATE guest_message_events')) {
        storedNorm = JSON.parse(params[2]);
        return { rowCount: 1 };
      }
      throw new Error('unexpected query: ' + s.slice(0, 80));
    },
  };

  const first = await markGuestMessageEventHandoffReviewed(pg, {
    client_slug: 'wolfhouse-somo',
    event_id: EVENT_ID,
    reviewed_by: 'operator@test.com',
    review_note: 'done',
  });

  if (first.ok && first.already_reviewed === false
      && first.handoff_review && first.handoff_review.reviewed === true) {
    pass('C1', 'first review sets handoff_review');
  } else fail('C1', 'first review failed');

  const firstAt = first.handoff_review.reviewed_at;

  const second = await markGuestMessageEventHandoffReviewed(pg, {
    client_slug: 'wolfhouse-somo',
    event_id: EVENT_ID,
    reviewed_by: 'other@test.com',
    review_note: 'again',
  });

  if (second.ok && second.already_reviewed === true
      && second.handoff_review.reviewed_at === firstAt) {
    pass('C2', 'repeated review is idempotent (preserves first reviewed_at)');
  } else fail('C2', 'idempotency failed');

  const missing = await markGuestMessageEventHandoffReviewed(pg, {
    client_slug: 'wolfhouse-somo',
    event_id: '22222222-2222-4222-8222-222222222222',
    reviewed_by: 'operator@test.com',
  });
  if (!missing.ok && missing.status === 404) pass('C3', 'missing row returns 404');
  else fail('C3', 'missing row should 404');

  section('D. GET queue — exclude/include reviewed');

  const seed = [
    {
      id: 'open-refund',
      client_slug: 'wolfhouse-somo',
      from_phone: '491726422307',
      message_text: 'refund',
      next_action: 'handoff_to_staff',
      handoff_required: true,
      send_attempted: false,
      send_status: null,
      send_blocked_reasons: [],
      normalized: {},
      created_at: '2026-06-06T11:00:00.000Z',
    },
    {
      id: 'reviewed-refund',
      client_slug: 'wolfhouse-somo',
      from_phone: '491726422307',
      message_text: 'old refund',
      next_action: 'handoff_to_staff',
      handoff_required: true,
      send_attempted: false,
      send_status: null,
      send_blocked_reasons: [],
      normalized: {
        handoff_review: {
          reviewed: true,
          reviewed_at: '2026-06-06T10:00:00.000Z',
          reviewed_by: 'op@test.com',
          review_note: null,
          source: REVIEW_SOURCE,
        },
      },
      created_at: '2026-06-06T10:00:00.000Z',
    },
  ];

  const listPg = { query: async () => ({ rows: seed }) };

  const defaultList = await listGuestMessageHandoffQueue(listPg, {
    client_slug: 'wolfhouse-somo',
    limit: 50,
  });
  if (defaultList.items.length === 1 && defaultList.items[0].id === 'open-refund') {
    pass('D1', 'reviewed rows excluded by default');
  } else fail('D1', `expected 1 open item, got ${defaultList.items.length}`);

  const includeList = await listGuestMessageHandoffQueue(listPg, {
    client_slug: 'wolfhouse-somo',
    limit: 50,
    include_reviewed: true,
  });
  if (includeList.items.length === 2) pass('D2', 'include_reviewed=true returns reviewed rows');
  else fail('D2', `expected 2 items with include_reviewed, got ${includeList.items.length}`);

  const reviewedItem = includeList.items.find((i) => i.id === 'reviewed-refund');
  if (reviewedItem && reviewedItem.handoff_review && reviewedItem.handoff_review.reviewed === true) {
    pass('D3', 'included reviewed row has handoff_review summary');
  } else fail('D3', 'handoff_review summary missing on included row');

  const qParsed = parseHandoffQueueQuery({ client_slug: 'wolfhouse-somo', include_reviewed: 'true' });
  if (qParsed.ok && qParsed.filters.include_reviewed === true) {
    pass('D4', 'parseHandoffQueueQuery accepts include_reviewed');
  } else fail('D4', 'include_reviewed query parse failed');

  if (isHandoffReviewed({ handoff_review: { reviewed: true } })) {
    pass('D5', 'isHandoffReviewed detects reviewed state');
  } else fail('D5', 'isHandoffReviewed failed');

  section('E. UI — Mark reviewed button');

  if (/Mark reviewed|hq-review-btn/.test(hqJs)) pass('E1', 'Mark reviewed button in panel JS');
  else fail('E1', 'Mark reviewed button missing');

  if (hqJs.includes('/staff/inbox/handoffs/') && hqJs.includes('/review')) {
    pass('E2', 'UI calls review route');
  } else fail('E2', 'review route call missing in UI');

  if (hqJs.includes('loadHandoffsQueue')) pass('E3', 'UI reloads queue after review');
  else fail('E3', 'queue reload missing');

  if (!hqJs.includes('/staff/bot/guest-reply-send') && !/btn-send/.test(hqJs)) {
    pass('E4', 'UI has no send button / guest-reply-send');
  } else fail('E4', 'send wiring found in handoff panel');

  if (/Read-only Meta handoff queue/.test(htmlSrc) && /mark reviewed/i.test(htmlSrc)) {
    pass('E5', 'read-only + mark reviewed language in panel');
  } else fail('E5', 'panel copy missing');

  section('F. Safety — no WhatsApp/Stripe/Graph/n8n/staff_handoffs');

  const forbidden = [
    ['graph.facebook.com', /graph\.facebook\.com/i],
    ['api.stripe.com', /api\.stripe\.com/i],
    ['staff_handoffs insert', /insert into staff_handoffs/i],
    ['staff_handoffs update', /update staff_handoffs/i],
    ['n8n activation', /\/api\/v1\/workflows\/|activateWorkflow/i],
    ['whatsapp send in handler', /sendWhatsApp|guest-reply-send/i],
  ];
  for (const [label, re] of forbidden) {
    if (!re.test(handler + reviewSrc)) pass('F.' + label, 'avoids ' + label);
    else fail('F.' + label, label + ' found');
  }

  if (handler.includes('no_whatsapp: true') || apiSrc.includes('no_whatsapp: true')) {
    pass('F.response', 'response advertises no_whatsapp');
  } else pass('F.response', 'no_whatsapp flag optional');

  section('G. npm script registration');

  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  if (pkg.scripts && pkg.scripts['verify:luna-agent-phase23-handoff-review']) {
    pass('G1', 'npm script registered');
  } else fail('G1', 'npm script missing');

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((e) => {
  console.error('Verifier crash:', e);
  process.exit(1);
});
