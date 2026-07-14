'use strict';

/**
 * Luna Front Desk — canonical Sunset quote application service (read-only).
 *
 * Shared by Staff schedule preview and Luna bot offering-quote. Never writes
 * bookings, service records, payments, or Stripe sessions.
 *
 * See docs/LUNA-FRONT-DESK-DOMAIN-CONTRACT.md §2.5, §3.
 */

const crypto = require('crypto');
const { normalizeSunsetBookingDatesInBody } = require('./sunset-guest-date-intake');
const { parseQuoteQuantity } = require('./sunset-group-lesson-quote');
const {
  catalogCommandFromQuoteCommand,
  executeSunsetCatalog,
  executeSunsetCatalogSync,
  findCatalogOffering,
} = require('./luna-front-desk-catalog-service');
const { SUNSET_CLIENT_SLUG } = require('./sunset-bookable-offerings');
const { evaluateSunsetOfferingDates } = require('./sunset-offering-schedule');
const { resolveActiveSunsetAdminPrice } = require('./sunset-admin-price-resolve');
const { packPriceItemCode } = require('./sunset-admin-price-identity');
const {
  normalizeComponents,
  validateScheduleBookingBody,
} = require('./sunset-schedule-booking-writes');
const { assertCourseAssignable } = require('./sunset-admin-course-join');
const { staffFacingSunsetPriceError } = require('./sunset-course-lesson-price-lookup');
const {
  normalizeSunsetLocationId,
  isSunsetLocationId,
} = require('./sunset-school-locations');
const { isSunsetAdminDbReadEnabled } = require('./tenant-business-config');

const QUOTE_CHANNELS = Object.freeze({
  MANUAL_STAFF: 'manual_staff',
  LUNA_WHATSAPP: 'luna_whatsapp',
});

const QUOTE_PROVENANCE_VERSION = 1;

const CLIENT_MONEY_FIELDS = [
  'unit_amount_cents', 'amount_cents', 'total_cents', 'line_total_cents',
  'unit_price', 'unit_amount', 'line_total', 'currency_amount', 'price_source',
];

function rejectClientSuppliedMoney(body) {
  const b = body && typeof body === 'object' ? body : {};
  for (const key of CLIENT_MONEY_FIELDS) {
    if (b[key] !== undefined && b[key] !== null && b[key] !== '') {
      return { ok: false, reason: 'client_money_rejected', field: key };
    }
  }
  if (b.components && typeof b.components === 'object') {
    for (const [compKey, compVal] of Object.entries(b.components)) {
      if (!compVal || typeof compVal !== 'object') continue;
      for (const key of CLIENT_MONEY_FIELDS) {
        if (compVal[key] !== undefined && compVal[key] !== null && compVal[key] !== '') {
          return { ok: false, reason: 'client_money_rejected', field: `components.${compKey}.${key}` };
        }
      }
    }
  }
  if (b.price && typeof b.price === 'object') {
    for (const key of ['amount_cents', 'unit_amount_cents', 'total_cents']) {
      if (b.price[key] !== undefined && b.price[key] !== null) {
        return { ok: false, reason: 'client_money_rejected', field: `price.${key}` };
      }
    }
  }
  return { ok: true };
}

function buildSunsetQuoteCommand(opts) {
  const channel = String((opts && opts.channel) || '').trim();
  if (!Object.values(QUOTE_CHANNELS).includes(channel)) {
    return { ok: false, status: 400, body: { success: false, reason_code: 'invalid_channel', error: 'invalid quote channel' } };
  }
  const rawLoc = opts && opts.trustedLocationId;
  const locationId = normalizeSunsetLocationId(rawLoc);
  if (rawLoc != null && String(rawLoc).trim() && !isSunsetLocationId(rawLoc)) {
    return {
      ok: false,
      status: 400,
      body: {
        success: false,
        reason_code: 'wrong_location',
        reason: 'wrong_location',
        error: 'wrong location',
        location_id: String(rawLoc).trim(),
      },
    };
  }
  const transportBody = (opts && opts.transportBody) || {};
  const moneyReject = rejectClientSuppliedMoney(transportBody);
  if (!moneyReject.ok) {
    return {
      ok: false,
      status: 400,
      body: {
        success: false,
        reason_code: moneyReject.reason,
        error: 'Client-supplied price fields are not accepted.',
        field: moneyReject.field,
      },
    };
  }
  return {
    ok: true,
    command: {
      channel,
      clientSlug: SUNSET_CLIENT_SLUG,
      locationId,
      transportBody,
      now: (opts && opts.now) instanceof Date ? opts.now : new Date(),
    },
  };
}

function resolveQuoteRequireDb(transportBody) {
  if (transportBody && (transportBody.require_db === true || transportBody.requireDb === true)) {
    return true;
  }
  return isSunsetAdminDbReadEnabled();
}

function computeBillableUnits(offering, serviceDates, quantity) {
  const dates = serviceDates || [];
  const unit = String(
    offering.billing_unit || (offering.price && offering.price.unit) || '',
  ).toLowerCase();
  const sessionUnit = /session|single_lesson|person/.test(unit)
    && offering.offering_type !== 'course';
  const courseUnit = offering.offering_type === 'course'
    || offering.billing_mode === 'whole_offering_x_qty'
    || /week|course|bundle|day|^\d+_day|^\d+_days|^\d+_week/.test(unit);

  if (sessionUnit && !dates.length) return null;
  if (sessionUnit) return quantity * dates.length;
  if (courseUnit) return quantity;
  return quantity * Math.max(1, dates.length || 1);
}

function nestOfferingForQuote(raw) {
  return {
    offering_id: raw.offering_id,
    offering_type: raw.offering_type,
    course_id: raw.course_id || null,
    tier_key: raw.tier_key || (raw.tier && raw.tier.key) || null,
    label: raw.label,
    billing_unit: raw.billing_unit,
    billing_mode: raw.billing_mode || null,
    unit_amount_cents: raw.unit_amount_cents,
    currency: raw.currency || 'EUR',
    price_id: (raw.price_identity && raw.price_identity.price_id) || raw.price_id || null,
    price_source: raw.price_source || 'admin_db',
    offering_item_code: raw.offering_item_code || raw.item_code || raw.offering_id,
    item_code: raw.item_code || raw.offering_item_code || raw.offering_id,
    price_identity: raw.price_identity || null,
    schedule: raw.schedule || null,
    schedule_summary: raw.schedule && raw.schedule.summary,
  };
}

function mapQuoteFailure(reason, extra = {}) {
  const faced = staffFacingSunsetPriceError(reason);
  return {
    ok: false,
    status: extra.status || 422,
    body: {
      success: false,
      reason: reason || faced.reason_code,
      reason_code: extra.reason_code || faced.reason_code || reason,
      error: extra.error || faced.error,
      ...extra,
    },
  };
}

function buildQuoteProvenance(quoteBody) {
  const fp = computeQuoteFingerprint(quoteBody);
  return {
    quote_version: QUOTE_PROVENANCE_VERSION,
    quote_fingerprint: fp,
    quoted_at: quoteBody.quoted_at,
    offering_id: quoteBody.offering_id,
    offering_item_code: quoteBody.offering_item_code,
    course_id: quoteBody.course_id,
    tier_key: quoteBody.tier_key,
    service_dates: quoteBody.service_dates,
    quantity: quoteBody.quantity,
    unit_amount_cents: quoteBody.unit_amount_cents,
    total_cents: quoteBody.total_cents,
    currency: quoteBody.currency,
    price_source: quoteBody.price_source,
    capacity_by_date: quoteBody.capacity_by_date || null,
  };
}

function computeQuoteFingerprint(quoteBody) {
  const payload = {
    v: QUOTE_PROVENANCE_VERSION,
    client_slug: SUNSET_CLIENT_SLUG,
    location_id: quoteBody.location_id,
    offering_id: quoteBody.offering_id,
    offering_item_code: quoteBody.offering_item_code,
    course_id: quoteBody.course_id,
    tier_key: quoteBody.tier_key,
    service_dates: [...(quoteBody.service_dates || [])].sort(),
    quantity: quoteBody.quantity,
    unit_amount_cents: quoteBody.unit_amount_cents,
    total_cents: quoteBody.total_cents,
    currency: quoteBody.currency,
    price_source: quoteBody.price_source,
    billing_unit: quoteBody.billing_unit,
    capacity_by_date: quoteBody.capacity_by_date || null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

async function loadQuoteOfferings(pg, command, adminCfg, requireDb) {
  const catalogCmd = catalogCommandFromQuoteCommand(command);
  catalogCmd.requireDb = requireDb;
  const result = pg
    ? await executeSunsetCatalog(pg, catalogCmd, { adminCfg })
    : executeSunsetCatalogSync(catalogCmd, { adminCfg });
  if (!result.ok) {
    return {
      ok: false,
      reason: result.body.reason || result.body.reason_code,
      offerings: [],
      location_id: command.locationId,
    };
  }
  return {
    ok: true,
    source: result.body.source,
    offerings: result.body.offerings || [],
    location_id: result.body.location_id,
  };
}

function filterQuoteCatalogOfferings(catalog) {
  if (!catalog || !catalog.ok) return catalog;
  return {
    ...catalog,
    offerings: catalog.offerings || [],
  };
}

function extractServiceDates(transportBody) {
  const b = transportBody || {};
  if (Array.isArray(b.service_dates) && b.service_dates.length) {
    return [...new Set(b.service_dates.map((d) => String(d).slice(0, 10)).filter(Boolean))];
  }
  if (b.date_from || b.date_to) {
    const from = String(b.date_from || b.date_to).slice(0, 10);
    const to = String(b.date_to || b.date_from).slice(0, 10);
    if (from && to && from <= to) {
      const out = [];
      let cur = from;
      while (cur <= to && out.length < 31) {
        out.push(cur);
        const d = new Date(`${cur}T12:00:00Z`);
        d.setUTCDate(d.getUTCDate() + 1);
        cur = d.toISOString().slice(0, 10);
      }
      return out;
    }
  }
  if (b.date) return [String(b.date).slice(0, 10)];
  return [];
}

async function quoteOfferingLine(pg, command, offering, serviceDates, quantity, requireDb) {
  if (offering.offering_type === 'course' && serviceDates.length) {
    const scheduleCheck = evaluateSunsetOfferingDates(offering, serviceDates);
    if (!scheduleCheck.ok) {
      return mapQuoteFailure(scheduleCheck.reason, {
        status: 422,
        error: (scheduleCheck.staff_error && scheduleCheck.staff_error.error) || undefined,
        schedule_summary: scheduleCheck.schedule_summary,
        detail: scheduleCheck.detail || null,
      });
    }
    if (pg) {
      const cap = await assertCourseAssignable(pg, {
        clientSlug: SUNSET_CLIENT_SLUG,
        locationId: command.locationId,
        courseId: offering.course_id,
        serviceDates,
        quantity,
      });
      if (!cap.ok) {
        return {
          ok: false,
          status: cap.status || 409,
          body: {
            success: false,
            reason: cap.body && cap.body.error,
            reason_code: cap.body && (cap.body.reason_code || cap.body.error),
            error: cap.body && cap.body.error,
            course_id: offering.course_id,
            capacity_by_date: cap.body && cap.body.capacity_by_date,
          },
        };
      }
      offering._capacity_by_date = cap.capacity_by_date;
    }
  }

  let unitAmount = offering.unit_amount_cents;
  let priceSource = offering.price_source || 'admin_db';
  let priceId = offering.price_id;

  if (pg && requireDb && offering.price_identity) {
    const resolved = await resolveActiveSunsetAdminPrice(pg, {
      clientSlug: SUNSET_CLIENT_SLUG,
      locationId: command.locationId,
      quantity,
      metadata: {
        component: offering.offering_type === 'course' ? 'course' : offering.offering_type,
        staff_ui_service_type: offering.offering_type,
        course_id: offering.course_id,
        tier_key: offering.tier_key,
        offering_id: offering.offering_id,
        location_id: command.locationId,
      },
      pgClient: pg,
    });
    if (!resolved || !resolved.ok) {
      return mapQuoteFailure((resolved && resolved.reason) || 'price_not_configured');
    }
    unitAmount = resolved.unit_amount_cents;
    priceSource = resolved.price_source || 'admin_db';
    priceId = resolved.price_id || priceId;
  }

  return finalizeQuoteLine(offering, serviceDates, quantity, unitAmount, priceSource, priceId);
}

function quoteOfferingLineSync(command, offering, serviceDates, quantity, requireDb) {
  if (offering.offering_type === 'course' && serviceDates.length) {
    const scheduleCheck = evaluateSunsetOfferingDates(offering, serviceDates);
    if (!scheduleCheck.ok) {
      return mapQuoteFailure(scheduleCheck.reason, {
        status: 422,
        error: (scheduleCheck.staff_error && scheduleCheck.staff_error.error) || undefined,
        schedule_summary: scheduleCheck.schedule_summary,
        detail: scheduleCheck.detail || null,
      });
    }
  }
  const unitAmount = offering.unit_amount_cents != null
    ? offering.unit_amount_cents
    : (offering.price && offering.price.amount_cents);
  const priceSource = requireDb ? 'admin_db' : (offering.price_source || 'admin_db');
  const priceId = offering.price_id || (offering.price && offering.price.price_id);
  return finalizeQuoteLine(offering, serviceDates, quantity, unitAmount, priceSource, priceId);
}

function finalizeQuoteLine(offering, serviceDates, quantity, unitAmount, priceSource, priceId) {
  if (unitAmount == null || unitAmount < 0) {
    return mapQuoteFailure('price_missing');
  }
  const billableUnits = computeBillableUnits(offering, serviceDates, quantity);
  if (billableUnits == null) {
    return { ok: false, status: 422, body: { success: false, reason: 'incompatible_unit' } };
  }
  const total = unitAmount * billableUnits;
  return {
    ok: true,
    line: {
      component: offering.offering_type,
      offering_id: offering.offering_id,
      offering_item_code: offering.offering_item_code || offering.item_code,
      course_id: offering.course_id,
      tier_key: offering.tier_key,
      label: offering.label,
      quantity,
      service_dates: serviceDates,
      unit_amount_cents: unitAmount,
      billable_units: billableUnits,
      total_cents: total,
      currency: offering.currency || 'EUR',
      billing_unit: offering.billing_unit,
      billing_mode: offering.billing_mode,
      price_id: priceId,
      price_source: priceSource,
      capacity_by_date: offering._capacity_by_date || null,
    },
  };
}

function buildOfferingQuoteResult(command, catalog, offering, lineOut) {
  if (!lineOut.ok) return lineOut;
  const line = lineOut.line;
  const quotedAt = command.now.toISOString();
  const quoteBody = {
    success: true,
    client_slug: SUNSET_CLIENT_SLUG,
    location_id: command.locationId,
    channel: command.channel,
    offering_id: line.offering_id,
    offering_type: offering.offering_type,
    course_id: line.course_id,
    tier_key: line.tier_key,
    label: line.label,
    quantity: line.quantity,
    service_dates: line.service_dates,
    date_count: line.service_dates.length,
    unit_amount_cents: line.unit_amount_cents,
    billable_units: line.billable_units,
    total_cents: line.total_cents,
    line_total_cents: line.total_cents,
    currency: line.currency,
    price_unit: line.billing_unit,
    billing_unit: line.billing_unit,
    billing_mode: line.billing_mode,
    price_id: line.price_id,
    price_source: line.price_source,
    source: catalog.source,
    offering_item_code: line.offering_item_code,
    price_identity: offering.price_identity,
    schedule_summary: offering.schedule_summary,
    capacity_by_date: line.capacity_by_date,
    quoted_at: quotedAt,
  };
  quoteBody.quote_provenance = buildQuoteProvenance(quoteBody);
  return { ok: true, status: 200, body: quoteBody };
}

function resolveOfferingQuoteInputs(command, catalog) {
  const body = command.transportBody;
  const offeringId = String(body.offering_id || '').trim();
  if (!offeringId) {
    return { ok: false, result: { ok: false, status: 400, body: { success: false, reason: 'unknown_offering' } } };
  }
  const matches = findCatalogOffering({ offerings: catalog.offerings }, offeringId);
  if (!matches.length) {
    return { ok: false, result: quoteUnknownOfferingFallback(catalog, body, offeringId) };
  }
  if (matches.length > 1) {
    return { ok: false, result: { ok: false, status: 422, body: { success: false, reason: 'ambiguous_price' } } };
  }
  const offering = nestOfferingForQuote(matches[0]);
  if (offering.offering_type === 'course' && body.course_id == null) {
    return { ok: false, result: { ok: false, status: 422, body: { success: false, reason: 'course_identity_missing' } } };
  }
  if (body.course_id != null && String(offering.course_id || '') !== String(body.course_id)) {
    return { ok: false, result: { ok: false, status: 422, body: { success: false, reason: 'mismatched_course_offering' } } };
  }
  const quantity = parseQuoteQuantity(body.quantity);
  if (quantity == null) {
    return { ok: false, result: { ok: false, status: 422, body: { success: false, reason: 'incompatible_unit' } } };
  }
  return {
    ok: true,
    offering,
    serviceDates: extractServiceDates(body),
    quantity,
  };
}

async function quoteByOfferingId(pg, command, catalog, requireDb) {
  const resolved = resolveOfferingQuoteInputs(command, catalog);
  if (!resolved.ok) return resolved.result;
  const lineOut = await quoteOfferingLine(
    pg,
    command,
    resolved.offering,
    resolved.serviceDates,
    resolved.quantity,
    requireDb,
  );
  return buildOfferingQuoteResult(command, catalog, resolved.offering, lineOut);
}

function quoteByOfferingIdSync(command, catalog, requireDb) {
  const resolved = resolveOfferingQuoteInputs(command, catalog);
  if (!resolved.ok) return resolved.result;
  const lineOut = quoteOfferingLineSync(
    command,
    resolved.offering,
    resolved.serviceDates,
    resolved.quantity,
    requireDb,
  );
  return buildOfferingQuoteResult(command, catalog, resolved.offering, lineOut);
}

function quoteUnknownOfferingFallback(catalog, body, offeringId) {
  const adminCfg = catalog._adminCfg;
  if (adminCfg) {
    const rawPrices = (adminCfg.prices || []).filter(
      (p) => p.id === offeringId || p.offering_key === offeringId || p.item_code === offeringId,
    );
    if (rawPrices.length > 1) return { ok: false, status: 422, body: { success: false, reason: 'ambiguous_price' } };
    if (rawPrices.length === 1) {
      const asOf = body.as_of_date || body.date;
      if (rawPrices[0].active === false) {
        return { ok: false, status: 422, body: { success: false, reason: 'inactive_offering' } };
      }
      if (rawPrices[0].effective_from && String(rawPrices[0].effective_from).slice(0, 10) > String(asOf || '').slice(0, 10)) {
        return { ok: false, status: 422, body: { success: false, reason: 'future_price' } };
      }
      if (rawPrices[0].effective_to && String(rawPrices[0].effective_to).slice(0, 10) < String(asOf || '').slice(0, 10)) {
        return { ok: false, status: 422, body: { success: false, reason: 'expired_price' } };
      }
    }
    const knownUnpriced = (adminCfg.lesson_times || []).some((s) => `lesson_slot_${s.slot_id}__session` === offeringId)
      || (adminCfg.surf_packs || []).some((p) => (p.price_tiers || []).some((t) => `surf_pack_${p.pack_id}__${t.key}` === offeringId));
    if (knownUnpriced) {
      return { ok: false, status: 422, body: { success: false, reason: 'price_missing' } };
    }
  }
  if (catalog.source !== 'db' && isSunsetAdminDbReadEnabled()) {
    return { ok: false, status: 422, body: { success: false, reason: 'admin_db_expected_unavailable' } };
  }
  return { ok: false, status: 422, body: { success: false, reason: 'unknown_offering' } };
}

async function quoteByComponents(pg, command, catalog, requireDb) {
  const dateNorm = normalizeSunsetBookingDatesInBody(command.transportBody, command.now);
  if (!dateNorm.ok) {
    return {
      ok: false,
      status: 400,
      body: {
        success: false,
        reason: dateNorm.reason || 'invalid_date',
        reason_code: dateNorm.reason || 'invalid_date',
        needs_clarification: dateNorm.needs_clarification === true,
      },
    };
  }
  const validated = validateScheduleBookingBody(dateNorm.body);
  if (!validated.ok) {
    return { ok: false, status: 400, body: { success: false, error: validated.error, reason: validated.error } };
  }
  const input = validated.value;
  const serviceDates = input.service_dates || [];
  const lines = [];
  let totalCents = 0;
  let currency = 'EUR';

  if (input.components.course) {
    const comp = input.components.course;
    const tierKey = String(comp.tier_key || '').trim();
    const offeringId = comp.offering_id || packPriceItemCode(comp.course_id, tierKey);
    const matches = findCatalogOffering({ offerings: catalog.offerings }, offeringId);
    if (!matches.length) {
      return { ok: false, status: 422, body: { success: false, reason: 'unknown_offering' } };
    }
    const offering = nestOfferingForQuote(matches[0]);
    const qty = Math.max(1, Number(comp.quantity) || 1);
    const lineOut = pg
      ? await quoteOfferingLine(pg, command, offering, serviceDates, qty, requireDb)
      : quoteOfferingLineSync(command, offering, serviceDates, qty, requireDb);
    if (!lineOut.ok) return lineOut;
    lines.push({ ...lineOut.line, component: 'course' });
    totalCents += lineOut.line.total_cents;
    currency = lineOut.line.currency;
  }

  if (input.components.private_lesson) {
    const pl = input.components.private_lesson;
    const matches = (catalog.offerings || []).filter((o) => o.offering_type === 'private_lesson');
    if (!matches.length) {
      return { ok: false, status: 422, body: { success: false, reason: 'price_missing' } };
    }
    const offering = nestOfferingForQuote(matches[0]);
    const sessions = pl.sessions || [];
    const dates = sessions.map((s) => String(s.date).slice(0, 10)).filter(Boolean);
    const qty = Math.max(1, Number(pl.quantity) || 1);
    const lineOut = pg
      ? await quoteOfferingLine(pg, command, offering, dates.length ? dates : serviceDates, qty, requireDb)
      : quoteOfferingLineSync(command, offering, dates.length ? dates : serviceDates, qty, requireDb);
    if (!lineOut.ok) return lineOut;
    lines.push({ ...lineOut.line, component: 'private_lesson' });
    totalCents += lineOut.line.total_cents;
    currency = lineOut.line.currency;
  }

  for (const rentalKey of ['surfboard', 'wetsuit']) {
    if (!input.components[rentalKey]) continue;
    const comp = input.components[rentalKey];
    const rentalOfferingKey = rentalKey === 'surfboard' ? 'board_rental__1_day' : 'wetsuit_rental__1_day';
    const matches = findCatalogOffering({ offerings: catalog.offerings }, rentalOfferingKey)
      .concat((catalog.offerings || []).filter((o) => o.offering_type === 'rental'
        && String(o.item_code || o.offering_id || '').includes(rentalKey === 'surfboard' ? 'board' : 'wetsuit')));
    if (!matches.length) {
      return { ok: false, status: 422, body: { success: false, reason: 'price_missing' } };
    }
    const offering = nestOfferingForQuote(matches[0]);
    const qty = Math.max(1, Number(comp.quantity) || 1);
    const lineOut = pg
      ? await quoteOfferingLine(pg, command, offering, serviceDates, qty, requireDb)
      : quoteOfferingLineSync(command, offering, serviceDates, qty, requireDb);
    if (!lineOut.ok) return lineOut;
    lines.push({ ...lineOut.line, component: rentalKey });
    totalCents += lineOut.line.total_cents;
    currency = lineOut.line.currency;
  }

  if (!lines.length) {
    return { ok: false, status: 400, body: { success: false, reason: 'quote_input_required' } };
  }

  const primary = lines[0];
  const quotedAt = command.now.toISOString();
  const quoteBody = {
    success: true,
    client_slug: SUNSET_CLIENT_SLUG,
    location_id: command.locationId,
    channel: command.channel,
    line_items: lines,
    offering_id: primary.offering_id,
    course_id: primary.course_id,
    tier_key: primary.tier_key,
    quantity: primary.quantity,
    service_dates: serviceDates,
    unit_amount_cents: primary.unit_amount_cents,
    total_cents: totalCents,
    line_total_cents: totalCents,
    currency,
    price_source: primary.price_source,
    source: catalog.source,
    offering_item_code: primary.offering_item_code,
    billing_unit: primary.billing_unit,
    billing_mode: primary.billing_mode,
    capacity_by_date: primary.capacity_by_date,
    quoted_at: quotedAt,
  };
  quoteBody.quote_provenance = buildQuoteProvenance(quoteBody);
  return { ok: true, status: 200, body: quoteBody };
}

function quoteByComponentsSync(command, catalog, requireDb) {
  const dateNorm = normalizeSunsetBookingDatesInBody(command.transportBody, command.now);
  if (!dateNorm.ok) {
    return {
      ok: false,
      status: 400,
      body: {
        success: false,
        reason: dateNorm.reason || 'invalid_date',
        reason_code: dateNorm.reason || 'invalid_date',
        needs_clarification: dateNorm.needs_clarification === true,
      },
    };
  }
  const validated = validateScheduleBookingBody(dateNorm.body);
  if (!validated.ok) {
    return { ok: false, status: 400, body: { success: false, error: validated.error, reason: validated.error } };
  }
  const input = validated.value;
  const serviceDates = input.service_dates || [];
  const lines = [];
  let totalCents = 0;
  let currency = 'EUR';
  if (input.components.course) {
    const comp = input.components.course;
    const tierKey = String(comp.tier_key || '').trim();
    const offeringId = comp.offering_id || packPriceItemCode(comp.course_id, tierKey);
    const matches = findCatalogOffering({ offerings: catalog.offerings }, offeringId);
    if (!matches.length) {
      return { ok: false, status: 422, body: { success: false, reason: 'unknown_offering' } };
    }
    const offering = nestOfferingForQuote(matches[0]);
    const qty = Math.max(1, Number(comp.quantity) || 1);
    const lineOut = quoteOfferingLineSync(command, offering, serviceDates, qty, requireDb);
    if (!lineOut.ok) return lineOut;
    lines.push({ ...lineOut.line, component: 'course' });
    totalCents += lineOut.line.total_cents;
    currency = lineOut.line.currency;
  }
  if (!lines.length) {
    return { ok: false, status: 400, body: { success: false, reason: 'quote_input_required' } };
  }
  const primary = lines[0];
  const quotedAt = command.now.toISOString();
  const quoteBody = {
    success: true,
    client_slug: SUNSET_CLIENT_SLUG,
    location_id: command.locationId,
    channel: command.channel,
    line_items: lines,
    offering_id: primary.offering_id,
    course_id: primary.course_id,
    tier_key: primary.tier_key,
    quantity: primary.quantity,
    service_dates: serviceDates,
    unit_amount_cents: primary.unit_amount_cents,
    total_cents: totalCents,
    line_total_cents: totalCents,
    currency,
    price_source: primary.price_source,
    source: catalog.source,
    offering_item_code: primary.offering_item_code,
    billing_unit: primary.billing_unit,
    billing_mode: primary.billing_mode,
    capacity_by_date: primary.capacity_by_date,
    quoted_at: quotedAt,
  };
  quoteBody.quote_provenance = buildQuoteProvenance(quoteBody);
  return { ok: true, status: 200, body: quoteBody };
}

function executeSunsetQuoteSync(command, opts = {}) {
  if (!command || command.clientSlug !== SUNSET_CLIENT_SLUG) {
    return {
      ok: false,
      status: 403,
      body: { success: false, error: 'unsupported_client', reason_code: 'tenant_mismatch' },
    };
  }
  const requireDb = resolveQuoteRequireDb(command.transportBody);
  const adminCfg = opts.adminCfg || null;
  if (!adminCfg || adminCfg.ok === false) {
    return { ok: false, status: 422, body: { success: false, reason: 'admin_db_expected_unavailable' } };
  }
  if (requireDb && adminCfg.source !== 'db') {
    return { ok: false, status: 422, body: { success: false, reason: 'admin_db_expected_unavailable' } };
  }
  const catalogCmd = catalogCommandFromQuoteCommand(command);
  catalogCmd.requireDb = requireDb;
  const catalogResult = executeSunsetCatalogSync(catalogCmd, { adminCfg });
  if (!catalogResult.ok) {
    return {
      ok: false,
      status: catalogResult.status || 422,
      body: { success: false, reason: catalogResult.body.reason || catalogResult.body.reason_code },
    };
  }
  const filtered = filterQuoteCatalogOfferings({
    ok: true,
    offerings: catalogResult.body.offerings || [],
    source: catalogResult.body.source,
  });
  filtered._adminCfg = adminCfg;
  filtered.source = requireDb ? 'admin_db' : (filtered.source || adminCfg.source);
  const body = command.transportBody;
  if (body.offering_id) {
    return quoteByOfferingIdSync(command, filtered, requireDb);
  }
  if (body.components && Object.keys(body.components).length) {
    return quoteByComponentsSync(command, filtered, requireDb);
  }
  return { ok: false, status: 400, body: { success: false, reason: 'quote_input_required' } };
}

/**
 * Execute a read-only Sunset quote. pg may be null for config-only unit tests.
 */
async function executeSunsetQuote(pg, command, opts = {}) {
  if (!command || command.clientSlug !== SUNSET_CLIENT_SLUG) {
    return {
      ok: false,
      status: 403,
      body: { success: false, error: 'unsupported_client', reason_code: 'tenant_mismatch' },
    };
  }

  const requireDb = resolveQuoteRequireDb(command.transportBody);
  let adminCfg = opts.adminCfg || null;
  if (!adminCfg) {
    if (!pg) {
      return { ok: false, status: 500, body: { success: false, reason: 'admin_config_unavailable' } };
    }
    const { resolveTenantBusinessConfigAsync } = require('./tenant-business-config');
    adminCfg = await resolveTenantBusinessConfigAsync(SUNSET_CLIENT_SLUG, {
      locationId: command.locationId,
      pgClient: pg,
      skipDb: command.transportBody.dry_run === true,
    });
  }
  if (!adminCfg || adminCfg.ok === false) {
    return { ok: false, status: 422, body: { success: false, reason: 'admin_db_expected_unavailable' } };
  }
  if (requireDb && adminCfg.source !== 'db') {
    return { ok: false, status: 422, body: { success: false, reason: 'admin_db_expected_unavailable' } };
  }

  const catalogRaw = await loadQuoteOfferings(pg, command, adminCfg, requireDb);
  if (!catalogRaw.ok) {
    return { ok: false, status: 422, body: { success: false, reason: catalogRaw.reason } };
  }
  const catalog = filterQuoteCatalogOfferings(catalogRaw);
  catalog._adminCfg = adminCfg;
  catalog.source = requireDb ? 'admin_db' : (catalog.source || adminCfg.source);

  const body = command.transportBody;
  if (body.offering_id) {
    return quoteByOfferingId(pg, command, catalog, requireDb);
  }
  if (body.components && Object.keys(body.components).length) {
    return quoteByComponents(pg, command, catalog, requireDb);
  }
  return { ok: false, status: 400, body: { success: false, reason: 'quote_input_required' } };
}

/**
 * Re-quote with the same inputs and compare provenance — used before booking create.
 */
async function validateQuoteProvenanceForCreate(pg, command, provenance, opts = {}) {
  if (!provenance || typeof provenance !== 'object') {
    return { ok: true };
  }
  const quoteTransport = {
    ...command.transportBody,
    service_dates: provenance.service_dates || command.transportBody.service_dates,
    quantity: provenance.quantity != null ? provenance.quantity : command.transportBody.quantity,
    require_db: true,
  };
  if (command.transportBody.components && Object.keys(command.transportBody.components).length) {
    quoteTransport.components = command.transportBody.components;
    delete quoteTransport.offering_id;
  } else {
    quoteTransport.offering_id = provenance.offering_id || command.transportBody.offering_id;
    quoteTransport.course_id = provenance.course_id || command.transportBody.course_id;
    quoteTransport.tier_key = provenance.tier_key || command.transportBody.tier_key;
  }
  const quoteResult = await executeSunsetQuote(pg, {
    ...command,
    transportBody: quoteTransport,
  }, { adminCfg: opts.adminCfg });
  if (!quoteResult.ok) {
    return {
      ok: false,
      status: 409,
      body: {
        success: false,
        error: 'The quoted price is no longer available. Please request a fresh quote.',
        reason_code: 'stale_quote',
        detail: 'quote_refresh_failed',
        quote_error: quoteResult.body,
      },
    };
  }
  const fresh = buildQuoteProvenance(quoteResult.body);
  const expectedFp = provenance.quote_fingerprint || computeQuoteFingerprint(provenance);
  if (fresh.quote_fingerprint !== expectedFp) {
    return {
      ok: false,
      status: 409,
      body: {
        success: false,
        error: 'The quoted price is no longer available. Please request a fresh quote.',
        reason_code: 'stale_quote',
        detail: 'quote_fingerprint_mismatch',
        expected_fingerprint: expectedFp,
        current_fingerprint: fresh.quote_fingerprint,
        prior: provenance,
        current: fresh,
      },
    };
  }
  return { ok: true, current_provenance: fresh };
}

module.exports = {
  QUOTE_CHANNELS,
  QUOTE_PROVENANCE_VERSION,
  CLIENT_MONEY_FIELDS,
  buildSunsetQuoteCommand,
  executeSunsetQuote,
  executeSunsetQuoteSync,
  computeQuoteFingerprint,
  buildQuoteProvenance,
  validateQuoteProvenanceForCreate,
  rejectClientSuppliedMoney,
  computeBillableUnits,
};
