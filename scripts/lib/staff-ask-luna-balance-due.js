/**
 * Phase 11a — Staff Ask Luna balance-due query (read-only).
 *
 * Structured sources: bookings, payments, booking_service_records, booking_beds.
 * No chat logs, writes, Stripe, WhatsApp, or n8n.
 *
 * @module staff-ask-luna-balance-due
 */

'use strict';

const ACCOMM_LINE_CODES = Object.freeze({ package: true, package_proration: true, room_supplement: true });
const EXCLUDED_BOOKING_STATUSES = new Set(['cancelled', 'canceled', 'expired', 'hold']);
const CANCELLED_LINK_STATUSES = new Set(['cancelled', 'canceled', 'expired', 'failed']);
const ACTIVE_LINK_STATUSES = new Set(['checkout_created', 'draft', 'pending', 'payment_link_created']);

function parseMetadata(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

function isPaidPaymentStatus(status) {
  const s = String(status || '').toLowerCase();
  return s === 'paid' || s === 'succeeded';
}

function svcSum(svcRows) {
  return (svcRows || []).reduce((s, r) => s + (Number(r.amount_due_cents) || 0), 0);
}

function accommodationCents(bookingRow, svcDueCents, quoteSnap) {
  const svcSumVal = Number(svcDueCents || 0);
  if (quoteSnap && Array.isArray(quoteSnap.line_items)) {
    let sum = 0;
    let any = false;
    for (const li of quoteSnap.line_items) {
      if (li.code && ACCOMM_LINE_CODES[li.code] && li.total_cents != null) {
        sum += Number(li.total_cents);
        any = true;
      }
    }
    if (any) return sum;
  }
  if (bookingRow && bookingRow.total_amount_cents != null) {
    const total = Number(bookingRow.total_amount_cents);
    const derived = total - svcSumVal;
    return derived >= 0 ? derived : total;
  }
  return null;
}

function invoicePaidBalance(bookingRow, svcDueCents, ledgerPaidCents) {
  const md = parseMetadata(bookingRow.metadata);
  const quoteSnap = md.quote_snapshot || null;
  const svcSumVal = Number(svcDueCents || 0);
  const accCents = accommodationCents(bookingRow, svcSumVal, quoteSnap);
  const invoiceTotal = accCents != null
    ? accCents + svcSumVal
    : (svcSumVal > 0 ? svcSumVal : null);
  const paidTotal = ledgerPaidCents != null ? Number(ledgerPaidCents) : 0;
  const depositRequired = bookingRow.deposit_required_cents != null
    ? Number(bookingRow.deposit_required_cents) : 0;
  let balanceDue = null;
  if (invoiceTotal != null) {
    if (invoiceTotal > paidTotal) balanceDue = invoiceTotal - paidTotal;
    else balanceDue = 0;
  }
  return {
    invoice_total_cents: invoiceTotal,
    paid_total_cents: paidTotal,
    balance_due_cents: balanceDue,
    deposit_required_cents: depositRequired,
  };
}

function rowHasLinkUrl(pr) {
  if (!pr) return false;
  if (pr.checkout_url) return true;
  const md = parseMetadata(pr.metadata);
  return !!(md.payment_link_url || md.checkout_url);
}

function isActiveUnpaidLinkRow(pr) {
  if (!pr) return false;
  const st = String(pr.payment_status || '').toLowerCase();
  if (CANCELLED_LINK_STATUSES.has(st)) return false;
  if (!ACTIVE_LINK_STATUSES.has(st)) return false;
  if (Number(pr.amount_paid_cents || 0) > 0) return false;
  if (st === 'draft' && !rowHasLinkUrl(pr)) return false;
  return rowHasLinkUrl(pr) || !!pr.checkout_url;
}

function linkIntendedAmountCents(pr, ledgerCtx) {
  if (!pr) return null;
  const kind = String(pr.payment_kind || '').toLowerCase();
  if (kind === 'deposit_only' || kind === 'deposit') {
    return ledgerCtx.deposit_required_cents != null ? Number(ledgerCtx.deposit_required_cents) : null;
  }
  if (kind === 'addon_service') return null;
  return ledgerCtx.balance_due_cents != null ? Number(ledgerCtx.balance_due_cents) : null;
}

function isStaleUnpaidLinkRow(pr, ledgerCtx) {
  if (!isActiveUnpaidLinkRow(pr)) return false;
  const intended = linkIntendedAmountCents(pr, ledgerCtx);
  if (intended == null || intended <= 0) return false;
  return Number(pr.amount_due_cents) !== Number(intended);
}

function hasActivePaymentLink(paymentRows, ledgerCtx) {
  for (const pr of paymentRows || []) {
    if (isActiveUnpaidLinkRow(pr) && !isStaleUnpaidLinkRow(pr, ledgerCtx)) {
      return true;
    }
  }
  return false;
}

function paymentStateLabel(ledgerCtx, paymentRows) {
  const parts = [];
  const paid = Number(ledgerCtx.paid_total_cents || 0);
  const depositReq = Number(ledgerCtx.deposit_required_cents || 0);
  if (depositReq > 0 && paid >= depositReq) {
    parts.push('Deposit paid');
  } else if (paid > 0) {
    parts.push('Partial paid');
  }
  if (hasActivePaymentLink(paymentRows, ledgerCtx)) {
    parts.push('Link sent');
  } else {
    parts.push('No active link');
  }
  return parts.join(' / ');
}

function formatStayDates(checkIn, checkOut) {
  const fmt = (d) => {
    if (!d) return '';
    const dt = d instanceof Date ? d : new Date(String(d).slice(0, 10) + 'T12:00:00Z');
    if (Number.isNaN(dt.getTime())) return String(d);
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  };
  const a = fmt(checkIn);
  const b = fmt(checkOut);
  if (a && b) return `${a}–${b}`;
  return a || b || '';
}

function formatEuro(cents) {
  return `€${(Math.round(Number(cents) || 0) / 100).toFixed(0)}`;
}

function getBalanceDueActiveBookingsSql() {
  return `
SELECT
  b.id::text                AS booking_id,
  b.booking_code,
  b.guest_name,
  b.check_in,
  b.check_out,
  b.status::text            AS booking_status,
  b.payment_status::text    AS payment_status,
  b.total_amount_cents,
  b.deposit_required_cents,
  b.deposit_paid_cents,
  b.metadata,
  COALESCE(
    (SELECT STRING_AGG(rm_bed, ', ' ORDER BY rm_bed)
     FROM (
       SELECT DISTINCT bb.room_code || COALESCE('-' || NULLIF(bb.bed_code, ''), '') AS rm_bed
       FROM booking_beds bb
       WHERE bb.booking_id = b.id
         AND bb.room_code IS NOT NULL
     ) beds),
    NULLIF(b.primary_room_code, ''),
    ''
  ) AS bed_summary
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND LOWER(b.status::text) NOT IN ('cancelled', 'canceled', 'expired', 'hold')
ORDER BY b.check_in ASC NULLS LAST, b.booking_code ASC
`;
}

function getBalanceDueServiceAggSql() {
  return `
SELECT
  sr.booking_id::text       AS booking_id,
  COALESCE(SUM(sr.amount_due_cents), 0)::bigint AS service_due_cents
FROM booking_service_records sr
INNER JOIN bookings b ON b.id = sr.booking_id
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND sr.booking_id IS NOT NULL
GROUP BY sr.booking_id
`;
}

function getBalanceDuePaymentsSql() {
  return `
SELECT
  p.booking_id::text        AS booking_id,
  p.status::text            AS payment_status,
  p.payment_kind::text      AS payment_kind,
  p.amount_due_cents,
  p.amount_paid_cents,
  p.checkout_url,
  p.metadata
FROM payments p
INNER JOIN bookings b ON b.id = p.booking_id
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND LOWER(b.status::text) NOT IN ('cancelled', 'canceled', 'expired', 'hold')
ORDER BY p.created_at DESC
`;
}

/**
 * Registry / CLI SQL — active bookings with computed balance (service add-ons in invoice).
 *
 * @returns {string} Parameterised SQL ($1 = client slug)
 */
function getBalanceDueQuery() {
  return `
SELECT
  b.id::text                AS booking_id,
  b.booking_code,
  b.phone,
  b.guest_name,
  b.guest_count,
  b.package_code,
  b.check_in,
  b.check_out,
  b.payment_status::text,
  b.amount_paid_cents,
  b.total_amount_cents,
  b.deposit_required_cents,
  b.deposit_paid_cents,
  COALESCE(svc.service_due_cents, 0) AS service_due_cents,
  COALESCE(paid.paid_total_cents, 0)   AS paid_total_cents,
  GREATEST(
    0,
    COALESCE(b.total_amount_cents, 0) - COALESCE(paid.paid_total_cents, 0)
  )                         AS balance_due_cents,
  COALESCE(
    (SELECT STRING_AGG(rm_bed, ', ' ORDER BY rm_bed)
     FROM (
       SELECT DISTINCT bb.room_code || COALESCE('-' || NULLIF(bb.bed_code, ''), '') AS rm_bed
       FROM booking_beds bb
       WHERE bb.booking_id = b.id AND bb.room_code IS NOT NULL
     ) beds),
    NULLIF(b.primary_room_code, ''),
    ''
  ) AS bed_summary
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
LEFT JOIN LATERAL (
  SELECT COALESCE(SUM(sr.amount_due_cents), 0)::bigint AS service_due_cents
  FROM booking_service_records sr
  WHERE sr.booking_id = b.id
) svc ON TRUE
LEFT JOIN LATERAL (
  SELECT COALESCE(SUM(p.amount_paid_cents), 0)::bigint AS paid_total_cents
  FROM payments p
  WHERE p.booking_id = b.id
    AND LOWER(p.status::text) IN ('paid', 'succeeded')
) paid ON TRUE
WHERE c.slug = $1
  AND LOWER(b.status::text) NOT IN ('cancelled', 'canceled', 'expired', 'hold')
  AND GREATEST(
    0,
    COALESCE(b.total_amount_cents, 0) - COALESCE(paid.paid_total_cents, 0)
  ) > 0
ORDER BY b.check_in ASC
`;
}

/**
 * Full ledger-accurate balance-due rows for Ask Luna (includes payment state label).
 *
 * @param {object} pgClient
 * @param {string} clientSlug
 * @returns {Promise<object[]>}
 */
async function computeBalanceDueRows(pgClient, clientSlug) {
  const [bookingsRes, svcRes, paymentsRes] = await Promise.all([
    pgClient.query(getBalanceDueActiveBookingsSql(), [clientSlug]),
    pgClient.query(getBalanceDueServiceAggSql(), [clientSlug]).catch(() => ({ rows: [] })),
    pgClient.query(getBalanceDuePaymentsSql(), [clientSlug]),
  ]);

  const svcByBooking = new Map();
  for (const row of svcRes.rows) {
    svcByBooking.set(row.booking_id, Number(row.service_due_cents || 0));
  }

  const paymentsByBooking = new Map();
  for (const row of paymentsRes.rows) {
    const id = row.booking_id;
    if (!paymentsByBooking.has(id)) paymentsByBooking.set(id, []);
    paymentsByBooking.get(id).push(row);
  }

  const out = [];
  for (const bk of bookingsRes.rows) {
    const status = String(bk.booking_status || '').toLowerCase();
    if (EXCLUDED_BOOKING_STATUSES.has(status)) continue;

    const svcDue = svcByBooking.get(bk.booking_id) || 0;
    const paymentRows = paymentsByBooking.get(bk.booking_id) || [];
    const paidTotal = paymentRows.reduce((sum, pr) => {
      if (!isPaidPaymentStatus(pr.payment_status)) return sum;
      return sum + Number(pr.amount_paid_cents || 0);
    }, 0);

    const ledger = invoicePaidBalance(bk, svcDue, paidTotal);
    const balance = ledger.balance_due_cents;
    if (balance == null || balance <= 0) continue;

    out.push({
      booking_id:           bk.booking_id,
      booking_code:         bk.booking_code,
      guest_name:           bk.guest_name,
      check_in:             bk.check_in,
      check_out:            bk.check_out,
      bed_summary:          bk.bed_summary || null,
      payment_status:       bk.payment_status,
      invoice_total_cents:  ledger.invoice_total_cents,
      paid_total_cents:     ledger.paid_total_cents,
      balance_due_cents:    balance,
      payment_state_label:  paymentStateLabel(ledger, paymentRows),
    });
  }

  return out;
}

/** Same normalization as Ask Luna router (deterministic; no LLM). */
function normalizeBalanceDueQuestionText(question) {
  let q = String(question || '').toLowerCase().trim();
  q = q.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  q = q.replace(/[''`´]/g, ' ');
  q = q.replace(/\bwho\s+s\b/g, 'who');
  q = q.replace(/[?!.,;:()[\]{}""]/g, ' ');
  q = q.replace(/\s+/g, ' ').trim();
  return q;
}

const BALANCE_DUE_INTENT_KEY = 'payments.balance_due';

function matchesBalanceDueQuestion(question) {
  const normalized = normalizeBalanceDueQuestionText(question);
  const patterns = [
    /\bwho\s+owes?\s+money\b/,
    /\bwho\s+has\s+(?:an?\s+)?(?:unpaid\s+)?balance\s+due\b/,
    /\bwho\s+has\s+(?:an?\s+)?unpaid\s+balance\b/,
    /\bwho\s+has\s+(?:an?\s+)?outstanding\s+balance\b/,
    /\bwho\s+still\s+needs?\s+to\s+pay\b/,
    /\boutstanding\s+balances?\b/,
    /\bunpaid\s+balances?\b/,
    /\bbalance\s+due\b/,
    /\bpayment\s+follow[\s-]?up\b/,
    /\bfollow[\s-]?up\b.*\bpayment\b/,
    /\bpayment\b.*\bfollow[\s-]?up\b/,
    /\bbookings?\s+need(?:ing)?\s+payment\s+follow[\s-]?up\b/,
    /\bwho\s+needs?\s+payment\s+follow[\s-]?up\b/,
    /\bwho\s+should\s+i\s+follow[\s-]?up\b.*\bpayment\b/,
    /\b(owes?|owed|still\s+ow)\b/,
    /\b(debe|deben|saldo)\b/,
    /\b(deve(\s+pagare)?)\b/,
    /\b(schuldet|offen)\b/,
    /\b(doit(\s+payer)?|solde)\b/,
  ];
  if (patterns.some((re) => re.test(normalized))) return true;
  if (/\b(quien|who)\b/.test(normalized) && /\b(debe|owes?)\b/.test(normalized)) return true;
  if (/\b(quien|who)\b/.test(normalized) && /\bpagar\b/.test(normalized) && /\bdebe\b/.test(normalized)) {
    return true;
  }
  return false;
}

/**
 * Resolve balance-due intent from raw staff question (registry key + phrases).
 * @returns {string|null} `payments.balance_due` or null
 */
function resolveBalanceDueIntentKey(question, registryByKey) {
  const raw = String(question || '').trim().toLowerCase();
  if (raw === BALANCE_DUE_INTENT_KEY) return BALANCE_DUE_INTENT_KEY;
  if (registryByKey && typeof registryByKey.has === 'function' && registryByKey.has(raw)) {
    return raw === BALANCE_DUE_INTENT_KEY ? BALANCE_DUE_INTENT_KEY : null;
  }
  const normalized = normalizeBalanceDueQuestionText(question);
  if (normalized === 'payments balance_due' || normalized === 'payments balance due') {
    return BALANCE_DUE_INTENT_KEY;
  }
  if (registryByKey && registryByKey.has(normalized)) {
    return normalized === BALANCE_DUE_INTENT_KEY ? BALANCE_DUE_INTENT_KEY : null;
  }
  if (matchesBalanceDueQuestion(question)) return BALANCE_DUE_INTENT_KEY;
  return null;
}

function formatAskLunaBalanceDueAnswer(rows) {
  if (!rows || rows.length === 0) {
    return 'No active bookings currently have a balance due.';
  }

  const totalCents = rows.reduce((s, r) => s + Number(r.balance_due_cents || 0), 0);
  const lines = rows.map((r, i) => {
    const name = r.guest_name || r.booking_code || 'Guest';
    const dates = formatStayDates(r.check_in, r.check_out);
    const room = r.bed_summary ? ` — ${r.bed_summary}` : '';
    const datePart = dates ? ` — ${dates}` : '';
    return `${i + 1}. ${name} — ${formatEuro(r.balance_due_cents)} due${datePart}${room} — ${r.payment_state_label}`;
  });

  return [
    'People with balance due:',
    '',
    ...lines,
    '',
    `Total outstanding: ${formatEuro(totalCents)} across ${rows.length} booking${rows.length !== 1 ? 's' : ''}.`,
  ].join('\n');
}

module.exports = {
  getBalanceDueQuery,
  getBalanceDueActiveBookingsSql,
  computeBalanceDueRows,
  formatAskLunaBalanceDueAnswer,
  normalizeBalanceDueQuestionText,
  matchesBalanceDueQuestion,
  resolveBalanceDueIntentKey,
  BALANCE_DUE_INTENT_KEY,
  isPaidPaymentStatus,
  invoicePaidBalance,
};
