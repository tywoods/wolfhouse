'use strict';

const crypto = require('node:crypto');
const {
  AVAILABILITY_CHANNELS,
  buildWolfhouseAvailabilityCommand,
  executeWolfhouseAvailabilityCheck,
  buildCheckedWolfhousePreviewOffer,
} = require('../luna-front-desk-accommodation-availability-service');
const {
  loadBookingQuoteConfigWithOverlay,
} = require('../luna-front-desk-accommodation-booking-create-service');
const { calculateWolfhouseQuote } = require('../wolfhouse-quote-calculator');
const pricingStore = require('../wolfhouse-pricing-store');
const { resolveSeasonForDate } = require('../wolfhouse-pricing-resolve');
const { assertSafeToolRequest } = require('./contracts');
const v3 = require('./v3-operations');

const TENANT = 'wolfhouse-somo';
const WIRES = Object.freeze({
  checkAvailability: 'check_availability',
  findRooms: 'find_rooms',
  getPricingCatalog: 'get_pricing_catalog',
  quote: 'quote',
  holdBeds: 'hold_beds',
  book: 'book',
  getBooking: 'get_booking',
  recoverOperation: 'recover_operation',
  releaseHold: 'release_hold',
  handoffToHuman: 'handoff_to_human',
  getPaymentStatus: 'get_payment_status',
  sendPaymentLink: 'send_payment_link',
  cancelUnpaid: 'cancel_unpaid',
  readNotes: 'read_notes',
  writeNote: 'write_note',
  saveTransferRequest: 'save_transfer_request',
});

function trusted(context) {
  if (!context || context.tenantId !== TENANT) throw new Error('trusted Wolfhouse context is required');
  return context;
}

function validate(name, input) {
  assertSafeToolRequest(WIRES[name], input);
}

function availabilityBody(input, assignmentMode = false) {
  return {
    check_in: input.check_in,
    check_out: input.check_out,
    guest_count: input.party_size,
    room_type: input.room_type || (input.preferences && input.preferences.room_type),
    room_preference: input.room_preference || (input.preferences && input.preferences.room_preference),
    keep_together: input.keep_together === true || Boolean(input.preferences && input.preferences.keep_together),
    group_gender: input.group_gender || (input.preferences && input.preferences.group_gender),
    guests: input.guests || (input.preferences && input.preferences.guests) || [],
    selected_bed_codes: input.selected_bed_codes,
  };
}

async function runAvailability(pg, input) {
  const built = buildWolfhouseAvailabilityCommand({
    channel: AVAILABILITY_CHANNELS.VERTICAL_ADAPTER,
    trustedClientSlug: TENANT,
    transportBody: availabilityBody(input),
    assignmentMode: false,
    demoCalendarEnrichment: false,
  });
  if (!built.ok) return built;
  const result = await executeWolfhouseAvailabilityCheck(pg, built.command);
  if (!result.ok || !result.body || !Array.isArray(result.body.available_beds)) return result;
  const held = await pg.query(`SELECT DISTINCT hb.bed_code
    FROM luna_v3_hold_beds hb JOIN luna_v3_holds h ON h.id=hb.hold_id
    JOIN clients c ON c.id=h.client_id
    WHERE c.slug=$1 AND h.state='active' AND h.expires_at>clock_timestamp()
      AND h.check_in<$3::date AND h.check_out>$2::date`, [TENANT, input.check_in, input.check_out]);
  const heldCodes = new Set(held.rows.map((row) => row.bed_code));
  const available = result.body.available_beds.filter((bed) => !heldCodes.has(bed.bed_code));
  const selected = Array.isArray(input.selected_bed_codes) ? input.selected_bed_codes : [];
  const authorityExact = result.body.exact_bed_eligibility || {};
  const heldSelected = selected.filter(code=>heldCodes.has(code));
  // Holds only add a narrow inventory refusal. Never erase a Staff eligibility refusal.
  const exact = selected.length ? { ...authorityExact,
    eligible:authorityExact.eligible === true && heldSelected.length === 0,
    unavailable_bed_codes:[...new Set([...(authorityExact.unavailable_bed_codes || []),...heldSelected])] } : authorityExact;
  const enough = result.body.has_enough_beds !== false && available.length >= Number(input.party_size || 0);
  const holdRevision = crypto.createHash('sha256').update([...heldCodes].sort().join('\n')).digest('hex').slice(0, 16);
  return { ...result, body: { ...result.body, available_beds: available, exact_bed_eligibility: exact,
    available_count: available.length, has_enough_beds: enough,
    blockers: enough ? result.body.blockers : [...new Set([...(result.body.blockers || []), 'not_enough_available_beds'])],
    provenance: { ...result.body.provenance,
      availability_fingerprint: `${result.body.provenance.availability_fingerprint}:holds:${holdRevision}` } } };
}

function serviceFailure(result) {
  return {
    ok: false,
    status: result.status || 422,
    code: result.body && (result.body.reason_code || result.body.error) || result.reason || 'staff_service_unavailable',
  };
}

async function checkAvailability(pg, input = {}, context) {
  trusted(context); validate('checkAvailability', input);
  const result = await runAvailability(pg, input);
  if (!result.ok) return serviceFailure(result);
  const body = result.body;
  return {
    ok: true,
    checkIn: body.check_in,
    checkOut: body.check_out,
    availableCount: body.available_count,
    beds: body.available_beds.map((bed) => ({ bedId: bed.bed_code, code: bed.bed_code, roomId: bed.room_code })),
    bedIds: body.available_beds.map((bed) => bed.bed_code),
    blockers: body.blockers,
    observationRevision: body.provenance.availability_fingerprint,
    activeHoldInclusion: 'authoritative',
  };
}

async function findRooms(pg, input = {}, context) {
  trusted(context); validate('findRooms', input);
  const result = await runAvailability(pg, input);
  if (!result.ok) return serviceFailure(result);
  const body = result.body;
  const grouped = new Map();
  for (const bed of body.available_beds) {
    if (!grouped.has(bed.room_code)) grouped.set(bed.room_code, { roomId: bed.room_code, roomType: bed.room_type, bedOptions: [] });
    grouped.get(bed.room_code).bedOptions.push({ bedId: bed.bed_code, code: bed.bed_code });
  }
  const rooms = [...grouped.values()].filter((room) => room.bedOptions.length >= input.party_size);
  return {
    ok: true,
    roomIds: rooms.map((room) => room.roomId),
    rooms,
    selectedRoomId: null,
    selectedBedIds: [],
    missingEligibilityFacts: body.room_eligibility && body.room_eligibility.status === 'unsure'
      ? body.room_eligibility.affected_guest_indices : [],
    blockers: body.blockers,
    observationRevision: body.provenance.availability_fingerprint,
    activeHoldInclusion: 'authoritative',
  };
}

async function loadStrictPricing(pg) {
  try {
    const seasons = await pricingStore.loadSeasons(pg, TENANT);
    const rules = await pricingStore.loadRules(pg, TENANT);
    const items = await pricingStore.loadItems(pg, TENANT);
    const transfers=[];
    if (!seasons.length || !rules.length || !items.length) throw new Error('empty authoritative Pricing');
    return { seasons, rules, items, transfers };
  } catch (cause) {
    const error = new Error('authoritative Staff Pricing is unavailable');
    error.code = 'STAFF_PRICING_UNAVAILABLE'; error.cause = cause; throw error;
  }
}

// V3 may use bundled structure and labels, but never bundled money. Rebuild all
// calculator money-bearing branches exclusively from active Staff Pricing rows.
async function loadV3DbOnlyQuoteConfig(pg) {
  const data = await loadStrictPricing(pg);
  const base = await loadBookingQuoteConfigWithOverlay(pg);
  const config = JSON.parse(JSON.stringify(base));
  config.packages = [];
  config.add_ons = {};
  config.room_supplements = {};
  config.deposits = { tiers: {} };
  const byItem = new Map(data.items.map((item) => [`${item.item_type}:${item.item_code}`, item]));
  for (const item of data.items.filter((row) => row.item_type === 'package')) {
    const meta = item.metadata || {};
    config.packages.push({ code: item.item_code, name: item.label,
      min_days: Number(meta.min_days) || 7, allow_daily_proration: meta.allow_daily_proration !== false,
      seasonal_prices: {} });
  }
  for (const rule of data.rules) {
    const cents = Number(rule.amount_cents);
    if (!Number.isSafeInteger(cents) || cents < 0) throw Object.assign(new Error('invalid authoritative Pricing row'), { code: 'STAFF_PRICING_UNAVAILABLE' });
    if (rule.item_type === 'package') {
      const pkg = config.packages.find((row) => row.code === rule.item_code);
      if (pkg && rule.season_code) pkg.seasonal_prices[rule.season_code] = { weekly_per_person_cents: cents };
    } else if (rule.item_type === 'deposit') {
      config.deposits.tiers[rule.item_code] = { amount_cents: cents, scope: rule.unit === 'per_person' ? 'per_person' : 'per_booking' };
      if (rule.item_code === 'standard_package') config.deposits.scope = rule.unit === 'per_person' ? 'per_person' : 'per_booking';
    } else if (rule.item_type === 'supplement') {
      config.room_supplements[rule.item_code] = rule.unit === 'per_person_per_night'
        ? { per_person_per_night_cents: cents } : { per_room_per_night_cents: cents };
    } else if (rule.item_type === 'service') {
      const item = byItem.get(`service:${rule.item_code}`);
      config.add_ons[rule.item_code] = { code: rule.item_code, name: item && item.label,
        pricing_unit: rule.unit, price_cents: cents,
        ...(rule.unit === 'per_lesson' ? { price_cents_each: cents } : {}) };
    } else if (rule.item_type === 'rental') {
      const code = rule.item_code.split('__')[0];
      config.add_ons[code] = { code, price_cents: cents, pricing_unit: rule.unit };
    }
  }
  for (const required of ['standard_package','custom_or_short_stay']) if (!config.deposits.tiers[required]) throw Object.assign(new Error(`missing Staff deposit tier ${required}`), { code:'staff_deposit_tier_unavailable' });
  return config;
}

function catalogRevision(data) {
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 24);
}

async function getPricingCatalog(pg, input = {}, context) {
  trusted(context); validate('getPricingCatalog', input);
  let data;
  try { data = await loadStrictPricing(pg); } catch (error) { return { ok: false, status: 503, code: error.code }; }
  const wantedPackages = input.package_ids && new Set(input.package_ids);
  const wantedServices = input.service_ids && new Set(input.service_ids);
  const items = data.items.filter((item) => (!wantedPackages || item.item_type !== 'package' || wantedPackages.has(item.item_code))
    && (!wantedServices || item.item_type !== 'service' || wantedServices.has(item.item_code)));
  const codes = new Set(items.map((item) => `${item.item_type}:${item.item_code}`));
  const rules = data.rules.filter((rule) => codes.has(`${rule.item_type}:${rule.item_code}`)
    || ['deposit', 'supplement'].includes(rule.item_type));
  return {
    ok: true, source: 'staff_pricing', version: catalogRevision(data),
    checkIn: input.check_in, checkOut: input.check_out,
    seasons: data.seasons, items, rules, transferOptions: data.transfers,
  };
}

async function computeQuote(pg, input = {}, context) {
  trusted(context); validate('quote', input);
  if (!context.authenticated || context.writeAllowed !== true || !context.sessionId || !context.principalId) {
    throw Object.assign(new Error('write admission denied'), { status: 403 });
  }
  const session = (await pg.query(`SELECT s.id,s.client_id,s.write_admitted FROM luna_v3_sessions s JOIN clients c ON c.id=s.client_id
    WHERE c.slug=$1 AND s.session_key=$2 AND s.principal_id=$3`, [TENANT, context.sessionId, context.principalId])).rows[0];
  if (!session || session.write_admitted !== true) throw Object.assign(new Error('write admission denied'), { status: 403 });
  const selectedBeds = input.selection.selected_bed_codes || input.selection.bed_ids;
  const suppliedGuestPackages = input.guest_packages || [];
  if (suppliedGuestPackages.length) {
    const ordinals = suppliedGuestPackages.map((row) => row && row.guest_number);
    const validOrdinals = ordinals.every(Number.isSafeInteger)
      && new Set(ordinals).size === input.guests.length
      && ordinals.length === input.guests.length
      && ordinals.every((ordinal) => ordinal >= 1 && ordinal <= input.guests.length);
    if (!validOrdinals) return { ok: false, status: 422, code: 'invalid_guest_package_ordinals' };
  }
  const guestPackages = [...suppliedGuestPackages].sort((a, b) => a.guest_number - b.guest_number);
  const availability = await runAvailability(pg, {
    check_in: input.check_in, check_out: input.check_out, party_size: input.guests.length,
    guests: input.guests, selected_bed_codes: selectedBeds,
    room_type: input.selection.room_type, room_preference: input.selection.room_preference,
    keep_together: input.selection.keep_together,
  });
  if (!availability.ok) return serviceFailure(availability);
  const current = availability.body;
  if (!current.exact_bed_eligibility || current.exact_bed_eligibility.eligible !== true) {
    return { ok: false, status: 409, code: 'selected_beds_unavailable' };
  }
  let config;
  try { config = await loadV3DbOnlyQuoteConfig(pg); }
  catch (error) { return { ok: false, status: 503, code: error.code || 'STAFF_PRICING_UNAVAILABLE' }; }
  const quoteResult = calculateWolfhouseQuote({
    client_slug: TENANT, check_in: input.check_in, check_out: input.check_out,
    guest_count: input.guests.length, guests: input.guests,
    guest_packages: guestPackages,
    // A guest who asks for a bed without selecting a surf package is an
    // accommodation-only quote. Keep the calculator's existing Staff-priced
    // Malibu reference path, rather than rejecting an omitted package as if it
    // were an unknown commercial choice.
    package_code: input.package_id || (guestPackages.length ? null : 'package_none'),
    room_type: input.selection.room_type || 'shared', add_ons: input.add_ons || [],
    payment_choice: 'deposit', uses_per_guest_deposits: true,
  }, config);
  if (!quoteResult || quoteResult.success !== true
      || !Number.isSafeInteger(quoteResult.total_cents)
      || !Number.isSafeInteger(quoteResult.deposit_required_cents)
      || !Number.isSafeInteger(quoteResult.balance_due_cents)) {
    return { ok: false, status: 422, code: quoteResult && quoteResult.reason_code || 'staff_quote_unavailable' };
  }
  const offer = buildCheckedWolfhousePreviewOffer({
    client_slug: TENANT, quote: quoteResult,
    availability: { ...current, availability_checked: true, status: 'checked', selected_bed_codes: selectedBeds },
    guests: input.guests, guest_packages: guestPackages, add_ons: input.add_ons || [],
    room_rows: current.available_beds, payment_choice: 'deposit',
    payment_distribution: quoteResult.per_guest_deposits || [],
  });
  const receipt = {
    ok: true, source: 'staff_pricing', quoteRevision: offer.offer_revision.offer_fingerprint,
    selectionRevision: current.provenance.availability_fingerprint, expiresAt: null,
    totalCents: quoteResult.total_cents, depositCents: quoteResult.deposit_required_cents,
    remainingCents: quoteResult.total_cents - quoteResult.deposit_required_cents, currency: quoteResult.currency,
    lineItems: quoteResult.line_items, perPerson: quoteResult.per_guest_deposits || [],
    eligibilityFacts: { packageEligible: quoteResult.package_eligible, blockers: quoteResult.blockers || [] },
  };
  const assignments = selectedBeds.map((bedCode, index) => ({
    bed_code: bedCode,
    guest_name: input.guests[index] && input.guests[index].name,
    package_code: ((input.guest_packages || []).find((p) => Number(p.guest_number) === index + 1) || {}).package_code || input.package_id || 'package_none',
  }));
  if (!context.revalidationOnly) await pg.query(`INSERT INTO luna_v3_selections(client_id,session_id,quote_revision,check_in,check_out,guests,assignments,quote)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb)
    ON CONFLICT(client_id,session_id,quote_revision) DO NOTHING`, [session.client_id, session.id,
    receipt.quoteRevision, input.check_in, input.check_out, JSON.stringify(input.guests), JSON.stringify(assignments),
    JSON.stringify({ ...receipt, phone: context.guestPhone || null, addOns: input.add_ons || [], quoteInput: input,
      packageCode: input.package_id || null, roomType: input.selection.room_type || 'shared',
      keepTogether: input.selection.keep_together === true })]);
  return { ...receipt, quotedSelection: receipt.quoteRevision };
}

async function quote(pg, input = {}, context) {
  if (context && context.revalidationOnly) return computeQuote(pg, input, context);
  trusted(context); validate('quote', input);
  const stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
  const fp = crypto.createHash('sha256').update(JSON.stringify(stable(input))).digest('hex');
  await pg.query('BEGIN');
  try {
    const s = (await pg.query(`SELECT s.id,s.client_id FROM luna_v3_sessions s JOIN clients c ON c.id=s.client_id WHERE c.slug=$1 AND s.session_key=$2 AND s.principal_id=$3`, [TENANT, context && context.sessionId, context && context.principalId])).rows[0];
    if (!s) throw Object.assign(new Error('write admission denied'), { status: 403 });
    const inserted = await pg.query(`INSERT INTO luna_v3_operations(client_id,session_id,tool,operation_key,request_fingerprint) VALUES($1,$2,'quote',$3,$4) ON CONFLICT(client_id,session_id,tool,operation_key) DO NOTHING RETURNING id,request_fingerprint,receipt`, [s.client_id,s.id,input.operation_key,fp]);
    const op = inserted.rows[0] || (await pg.query(`SELECT id,request_fingerprint,receipt FROM luna_v3_operations WHERE client_id=$1 AND session_id=$2 AND tool='quote' AND operation_key=$3 FOR UPDATE`, [s.client_id,s.id,input.operation_key])).rows[0];
    if (op.request_fingerprint !== fp) { await pg.query('ROLLBACK'); return { ok:false,outcome:'rejected',status:409,code:'operation_key_payload_mismatch' }; }
    if (op.receipt) { await pg.query('COMMIT'); return op.receipt; }
    await pg.query('SAVEPOINT luna_v3_quote_business');
    const receipt = await computeQuote(pg,input,context);
    if (!receipt.ok) await pg.query('ROLLBACK TO SAVEPOINT luna_v3_quote_business');
    const saved = receipt.ok ? { ...receipt, outcome:'applied' } : { ...receipt, outcome:'rejected' };
    await pg.query(`UPDATE luna_v3_operations SET receipt=$2::jsonb,outcome=$3,completed_at=now() WHERE id=$1`, [op.id,JSON.stringify(saved),saved.outcome]);
    await pg.query('COMMIT'); return saved;
  } catch (error) { await pg.query('ROLLBACK'); throw error; }
}

function createOperations(withPgClient, authorities = {}) {
  return Object.freeze(Object.fromEntries(Object.entries(WIRES).map(([name, wire]) => [wire,
    (input, context) => withPgClient((client) => SELECTED_IMPLEMENTATIONS[name](client, input,
      { ...context, staffAuthorities: authorities })),
  ])));
}

const SELECTED_IMPLEMENTATIONS = Object.freeze({ checkAvailability, findRooms, getPricingCatalog, quote, ...v3 });
module.exports = { ...SELECTED_IMPLEMENTATIONS, createOperations };
Object.defineProperty(module.exports,'loadV3DbOnlyQuoteConfig',{value:loadV3DbOnlyQuoteConfig,enumerable:false});
Object.freeze(module.exports);
