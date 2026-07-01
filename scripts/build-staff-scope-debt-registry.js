'use strict';

/**
 * One-shot generator for staff-tenant-scope-debt-registry.json (Slice 5).
 * Run: node scripts/build-staff-scope-debt-registry.js
 */

const fs = require('fs');
const path = require('path');

const HOTSPOTS_PATH = path.join(__dirname, 'fixtures', 'staff-tenant-scope-debt-hotspots.json');
const OUT_PATH = path.join(__dirname, 'fixtures', 'staff-tenant-scope-debt-registry.json');

const CONSOLE_LOG_ROUTE_LINES = new Set();

function slugFromRel(rel) {
  return rel.replace(/^scripts\//, '').replace(/\.js$/, '').replace(/\//g, '-');
}

function classify(hit) {
  const { rel, line, table, snippet } = hit;
  const base = {
    file: rel,
    line,
    table,
    snippet: snippet.slice(0, 120),
  };

  if (CONSOLE_LOG_ROUTE_LINES.has(line) || /console\.log\(/.test(snippet)) {
    return {
      ...base,
      id: `${slugFromRel(rel)}-${line}`,
      status: 'ok',
      risk: 'false_positive',
      reason: 'Startup route listing log line; table name appears in URL string only, not executable SQL.',
    };
  }

  if (/Method not allowed/.test(snippet) || /pathname\s*===/.test(snippet)) {
    return {
      ...base,
      id: `${slugFromRel(rel)}-${line}`,
      status: 'ok',
      risk: 'false_positive',
      reason: 'Route handler string or HTTP error copy; not executable SQL.',
    };
  }

  if (/staff\/bookings.*luna-notes/.test(snippet) || /BOOKING_LUNA_NOTES_RE/.test(snippet)) {
    return {
      ...base,
      id: `${slugFromRel(rel)}-${line}`,
      status: 'ok',
      risk: 'false_positive',
      reason: 'Express route path regex; not SQL.',
    };
  }

  if (rel.endsWith('staff-query-api.js') && /^\s*\/\//.test(snippet) && /[Pp]ayments aggregate/.test(snippet)) {
    return {
      ...base,
      id: `${slugFromRel(rel)}-${line}`,
      status: 'ok',
      risk: 'false_positive',
      reason: 'Comment only; not executable SQL.',
    };
  }

  if (rel.endsWith('staff-query-api.js') && /^\s*\/\/\s*──/.test(snippet)) {
    return {
      ...base,
      id: `${slugFromRel(rel)}-${line}`,
      status: 'ok',
      risk: 'false_positive',
      reason: 'Phase/route section comment; not executable SQL.',
    };
  }

  if (rel.endsWith('staff-query-api.js') && (line === 17953 || line === 22741)) {
    return {
      ...base,
      id: `${slugFromRel(rel)}-${line}`,
      status: 'ok',
      risk: 'false_positive',
      reason: 'Staff portal HTML/i18n template string; not a customers table query.',
    };
  }

  if (rel.endsWith('staff-query-api.js') && line === 24663) {
    return {
      ...base,
      id: `${slugFromRel(rel)}-${line}`,
      status: 'ok',
      risk: 'false_positive',
      reason: 'Agent session UI HTML button label; not a bookings query.',
    };
  }

  if (rel.endsWith('staff-query-api.js') && [8322, 14003, 14547].includes(line)) {
    return {
      ...base,
      id: `${slugFromRel(rel)}-${line}`,
      status: 'ok',
      risk: 'false_positive',
      reason: 'Comment or user-facing error copy; not executable SQL.',
    };
  }

  if (rel.includes('tenant-services-writes.js') && [251, 257].includes(line)) {
    return {
      ...base,
      id: `${slugFromRel(rel)}-${line}`,
      status: 'ok',
      risk: 'false_positive',
      reason: 'Postgres catalog/schema introspection for lazy CHECK migration twin; not tenant data access.',
    };
  }

  if (rel.endsWith('staff-query-api.js') && line === 1211) {
    return {
      ...base,
      id: `${slugFromRel(rel)}-${line}`,
      status: 'ok',
      risk: 'ok_session_or_indirect_scope',
      reason: 'Logout revokes the caller session by unique session_token_hash; no cross-tenant row selection.',
    };
  }

  const indirectBookingReason = 'Handler resolves booking_id/payment_id after a client_slug-scoped booking fetch in the same flow; safe on isolated Wolfhouse/Sunset staging DBs but lacks defense-in-depth client_id predicate on this statement.';
  const indirectFix = 'Add AND client_id = $n (from session or JOIN bookings.client_id) to the WHERE clause on this statement.';

  if (rel.includes('luna-guest-booking-write-bridge.js') && line === 175) {
    return {
      ...base,
      id: `${slugFromRel(rel)}-${line}`,
      status: 'todo',
      risk: 'must_fix_before_live_multiclient',
      reason: 'Guest idempotency replay lists payments by booking_id only; multiclient runtime must bind client_id from inbound channel.',
      suggested_fix: 'Pass resolved client_id from guest channel context and add WHERE p.client_id = $n.',
    };
  }

  if (rel.includes('luna-guest-hold-payment-draft-write.js') && line === 152) {
    return {
      ...base,
      id: `${slugFromRel(rel)}-${line}`,
      status: 'todo',
      risk: 'must_fix_before_live_multiclient',
      reason: 'Payment draft lookup by booking_id only; INSERT path sets client_id but SELECT does not filter by tenant.',
      suggested_fix: 'Add client_id parameter to loadPaymentDraftForBooking and WHERE client_id = $n.',
    };
  }

  if (rel.includes('staff-bot-v2-routes.js')) {
    return {
      ...base,
      id: `${slugFromRel(rel)}-${line}`,
      status: 'todo',
      risk: 'must_fix_before_live_multiclient',
      reason: 'Bot Stripe checkout path updates payment row by payment id only; bot token is per-deploy today but not client-scoped in SQL.',
      suggested_fix: 'Resolve bot client_slug to client_id and add WHERE id = $n AND client_id = $m on UPDATE payments.',
    };
  }

  if (rel.includes('tenant-services-writes.js')) {
    return {
      ...base,
      id: `${slugFromRel(rel)}-${line}`,
      status: 'todo',
      risk: 'must_fix_before_live_multiclient',
      reason: indirectBookingReason,
      suggested_fix: indirectFix,
    };
  }

  if (table === 'bookings') {
    return {
      ...base,
      id: `${slugFromRel(rel)}-${line}`,
      status: 'todo',
      risk: 'must_fix_before_live_multiclient',
      reason: indirectBookingReason,
      suggested_fix: indirectFix.replace('bookings.client_id', 'bookings.client_id').replace('this statement', 'bookings UPDATE/SELECT'),
    };
  }

  if (table === 'payments') {
    return {
      ...base,
      id: `${slugFromRel(rel)}-${line}`,
      status: 'todo',
      risk: 'must_fix_before_live_multiclient',
      reason: 'Payment row read/update by payment id or booking_id without client_id in this SQL window; Stripe webhook and staff flows assume single-tenant DB isolation today.',
      suggested_fix: 'JOIN bookings b ON b.id = payments.booking_id AND b.client_id = $session_client_id, or add payments.client_id = $n to WHERE.',
    };
  }

  if (table === 'booking_service_records') {
    return {
      ...base,
      id: `${slugFromRel(rel)}-${line}`,
      status: 'todo',
      risk: 'must_fix_before_live_multiclient',
      reason: indirectBookingReason,
      suggested_fix: 'JOIN bookings b ON b.id = booking_service_records.booking_id AND b.client_id = $session_client_id, or add client_id if column exists.',
    };
  }

  return {
    ...base,
    id: `${slugFromRel(rel)}-${line}`,
    status: 'todo',
    risk: 'must_fix_before_live_multiclient',
    reason: 'Unscoped tenant-sensitive table access; classify manually if this default is wrong.',
    suggested_fix: indirectFix,
  };
}

const hotspots = JSON.parse(fs.readFileSync(HOTSPOTS_PATH, 'utf8').replace(/^\uFEFF/, ''));
const entries = hotspots.map(classify);

const summary = {
  total: entries.length,
  by_status: {},
  by_risk: {},
};
for (const e of entries) {
  summary.by_status[e.status] = (summary.by_status[e.status] || 0) + 1;
  summary.by_risk[e.risk] = (summary.by_risk[e.risk] || 0) + 1;
}

const out = {
  schema_version: 1,
  generated_from: 'scripts/fixtures/staff-tenant-scope-debt-hotspots.json',
  slice: 'multiclient-sql-scope-debt-classification',
  summary,
  entries,
};

fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote ${entries.length} entries to ${OUT_PATH}`);
console.log(JSON.stringify(summary, null, 2));
