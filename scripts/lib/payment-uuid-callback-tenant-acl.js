'use strict';

/**
 * FORTRESS 15J3 — Bind path-UUID payment/booking callbacks to staff ACL or
 * bot-principal tenant before any Stripe/session/DB mutation (B15).
 *
 * Read-only object-tenant lookup → principal compare → fail closed.
 * Never derive trusted tenant solely from the object row without ACL/principal match.
 *
 * Staff foreign-object deny is normalized to the same uniform 404 shape as a
 * nonexistent UUID (no client_slug / existence / amount / booking / checkout
 * disclosure). Canonical assertStaffClientAccess still runs internally; its
 * 403 body is swallowed so the HTTP response stays indistinguishable.
 */

function trimSlug(v) {
  return String(v == null ? '' : v).trim();
}

/** Uniform staff/bot payment miss body (foreign deny ≡ nonexistent). */
const UNIFORM_PAYMENT_NOT_FOUND_BODY = Object.freeze({
  success: false,
  error: 'Payment record not found.',
});

/** Uniform staff booking miss body (foreign deny ≡ nonexistent). */
const UNIFORM_BOOKING_NOT_FOUND_BODY = Object.freeze({
  success: false,
  error: 'Booking not found.',
});

/** Sink res so assertStaffClientAccess can run without writing a distinguishable 403. */
function makeSilentAclRes() {
  return {
    writeHead() {},
    setHeader() {},
    end() {},
  };
}

/** Read-only payment tenant lookup (global by payment UUID). */
const PAYMENT_TENANT_LOOKUP_SQL = `
SELECT cl.slug AS client_slug
  FROM payments p
  JOIN clients cl ON cl.id = p.client_id
 WHERE p.id = $1::uuid
 LIMIT 1`;

/**
 * Read-only payment tenant lookup scoped to bot-bound slug.
 * Cross-tenant UUID → empty row (uniform miss; no foreign disclosure).
 */
const PAYMENT_TENANT_LOOKUP_BOUND_SQL = `
SELECT cl.slug AS client_slug
  FROM payments p
  JOIN clients cl ON cl.id = p.client_id
 WHERE p.id = $1::uuid
   AND cl.slug = $2
 LIMIT 1`;

/** Read-only booking tenant lookup (global by booking UUID). */
const BOOKING_TENANT_LOOKUP_SQL = `
SELECT b.id AS booking_id, b.booking_code, b.guest_name, b.client_id,
       cl.slug AS client_slug
  FROM bookings b
  JOIN clients cl ON cl.id = b.client_id
 WHERE b.id = $1
 LIMIT 1`;

/**
 * Staff: resolve payment object tenant (read-only), then assertStaffClientAccess
 * before any mutation. Denied foreign objects collapse to not_found (no slug leak).
 */
async function gateStaffPaymentUuidCallbackTenantAcl({
  paymentId,
  user,
  withPgClient,
  assertStaffClientAccess,
  res,
}) {
  let row;
  try {
    row = await withPgClient(async (pg) => {
      const r = await pg.query(PAYMENT_TENANT_LOOKUP_SQL, [paymentId]);
      return r.rows[0] || null;
    });
  } catch (err) {
    return { ok: false, error: err };
  }
  if (!row) {
    return { ok: false, not_found: true };
  }
  const clientSlug = trimSlug(row.client_slug);
  const aclRes = res && res.__allowAclDenyBody ? res : makeSilentAclRes();
  if (!assertStaffClientAccess(user, clientSlug, aclRes)) {
    return { ok: false, not_found: true };
  }
  return { ok: true, clientSlug };
}

/**
 * Bot: require nonempty boundClientSlug; SELECT payment AND cl.slug = bound.
 * Mismatch/missing → uniform 404 semantics (caller sends body). Never trust
 * object-derived slug alone.
 */
async function gateBotPaymentUuidCallbackTenantAcl({
  paymentId,
  boundClientSlug,
  withPgClient,
}) {
  const bound = trimSlug(boundClientSlug);
  if (!bound) {
    return { ok: false, reason: 'bound_client_slug_required' };
  }
  let row;
  try {
    row = await withPgClient(async (pg) => {
      const r = await pg.query(PAYMENT_TENANT_LOOKUP_BOUND_SQL, [paymentId, bound]);
      return r.rows[0] || null;
    });
  } catch (err) {
    return { ok: false, error: err };
  }
  if (!row) {
    return { ok: false, reason: 'payment_not_found_or_tenant_mismatch', boundClientSlug: bound };
  }
  return { ok: true, clientSlug: bound };
}

/**
 * Staff service-records: resolve booking object tenant (read-only), then
 * assertStaffClientAccess (canonical ACL — preserves secondary-client staff).
 * Foreign deny → not_found (no booking/slug disclosure on the wire).
 */
async function gateStaffBookingUuidCallbackTenantAcl({
  bookingId,
  user,
  withPgClient,
  assertStaffClientAccess,
  res,
}) {
  let row;
  try {
    row = await withPgClient(async (pg) => {
      const r = await pg.query(BOOKING_TENANT_LOOKUP_SQL, [bookingId]);
      return r.rows[0] || null;
    });
  } catch (err) {
    return { ok: false, error: err };
  }
  if (!row) {
    return { ok: false, not_found: true };
  }
  const clientSlug = trimSlug(row.client_slug);
  const aclRes = res && res.__allowAclDenyBody ? res : makeSilentAclRes();
  if (!assertStaffClientAccess(user, clientSlug, aclRes)) {
    return { ok: false, not_found: true };
  }
  return { ok: true, clientSlug, booking: row };
}

/**
 * Route-level harness: run staff payment gate then optional mutation.
 * On deny/not_found, mutation must not run (zero Stripe/DB writes).
 */
async function runStaffPaymentUuidCallbackWithTenantAcl(opts) {
  const gate = await gateStaffPaymentUuidCallbackTenantAcl(opts);
  if (!gate.ok) {
    if (gate.error) {
      opts.onDbError && opts.onDbError(gate.error);
      return { ...gate, mutated: false };
    }
    opts.onNotFound && opts.onNotFound();
    return { ...gate, mutated: false };
  }
  if (typeof opts.onAuthorizedMutation === 'function') {
    await opts.onAuthorizedMutation({ clientSlug: gate.clientSlug });
    return { ...gate, mutated: true };
  }
  return { ...gate, mutated: false };
}

/**
 * Route-level harness: run bot payment gate then optional mutation.
 */
async function runBotPaymentUuidCallbackWithTenantAcl(opts) {
  const gate = await gateBotPaymentUuidCallbackTenantAcl(opts);
  if (!gate.ok) {
    if (gate.error) {
      opts.onDbError && opts.onDbError(gate.error);
      return { ...gate, mutated: false };
    }
    opts.onDenied && opts.onDenied(gate);
    return { ...gate, mutated: false };
  }
  if (typeof opts.onAuthorizedMutation === 'function') {
    await opts.onAuthorizedMutation({ clientSlug: gate.clientSlug });
    return { ...gate, mutated: true };
  }
  return { ...gate, mutated: false };
}

/**
 * Route-level harness: run staff booking (service-records) gate then optional mutation.
 */
async function runStaffBookingUuidCallbackWithTenantAcl(opts) {
  const gate = await gateStaffBookingUuidCallbackTenantAcl(opts);
  if (!gate.ok) {
    if (gate.error) {
      opts.onDbError && opts.onDbError(gate.error);
      return { ...gate, mutated: false };
    }
    opts.onNotFound && opts.onNotFound();
    return { ...gate, mutated: false };
  }
  if (typeof opts.onAuthorizedMutation === 'function') {
    await opts.onAuthorizedMutation({ clientSlug: gate.clientSlug, booking: gate.booking });
    return { ...gate, mutated: true };
  }
  return { ...gate, mutated: false };
}

module.exports = {
  trimSlug,
  makeSilentAclRes,
  UNIFORM_PAYMENT_NOT_FOUND_BODY,
  UNIFORM_BOOKING_NOT_FOUND_BODY,
  PAYMENT_TENANT_LOOKUP_SQL,
  PAYMENT_TENANT_LOOKUP_BOUND_SQL,
  BOOKING_TENANT_LOOKUP_SQL,
  gateStaffPaymentUuidCallbackTenantAcl,
  gateBotPaymentUuidCallbackTenantAcl,
  gateStaffBookingUuidCallbackTenantAcl,
  runStaffPaymentUuidCallbackWithTenantAcl,
  runBotPaymentUuidCallbackWithTenantAcl,
  runStaffBookingUuidCallbackWithTenantAcl,
};
