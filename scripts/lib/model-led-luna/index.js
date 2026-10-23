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
  const enough = available.length >= Number(input.party_size || 0);
  const holdRevision = crypto.createHash('sha256').update([...heldCodes].sort().join('\n')).digest('hex').slice(0, 16);
  return { ...result, body: { ...result.body, available_beds: available,
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
    const [seasons, rules, items, transfers] = await Promise.all([
      pricingStore.loadSeasons(pg, TENANT), pricingStore.loadRules(pg, TENANT),
      pricingStore.loadItems(pg, TENANT), pricingStore.loadTransferRules(pg, TENANT),
    ]);
    if (!seasons.length || !rules.length || !items.length) throw new Error('empty authoritative Pricing');
    return { seasons, rules, items, transfers };
  } catch (cause) {
    const error = new Error('authoritative Staff Pricing is unavailable');
    error.code = 'STAFF_PRICING_UNAVAILABLE'; error.cause = cause; throw error;
  }
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

async function quote(pg, input = {}, context) {
  trusted(context); validate('quote', input);
  if (!context.authenticated || context.writeAllowed !== true || !context.sessionId || !context.principalId) {
    throw Object.assign(new Error('write admission denied'), { status: 403 });
  }
  const session = (await pg.query(`SELECT s.id,s.client_id,s.write_admitted FROM luna_v3_sessions s JOIN clients c ON c.id=s.client_id
    WHERE c.slug=$1 AND s.session_key=$2 AND s.principal_id=$3`, [TENANT, context.sessionId, context.principalId])).rows[0];
  if (!session || session.write_admitted !== true) throw Object.assign(new Error('write admission denied'), { status: 403 });
  const selectedBeds = input.selection.selected_bed_codes || input.selection.bed_ids;
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
  try { config = await loadBookingQuoteConfigWithOverlay(pg); }
  catch (error) { return { ok: false, status: 503, code: error.code || 'STAFF_PRICING_UNAVAILABLE' }; }
  const quoteResult = calculateWolfhouseQuote({
    client_slug: TENANT, check_in: input.check_in, check_out: input.check_out,
    guest_count: input.guests.length, guests: input.guests,
    guest_packages: input.guest_packages || [], package_code: input.package_id || null,
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
    guests: input.guests, guest_packages: input.guest_packages || [], add_ons: input.add_ons || [],
    room_rows: current.available_beds, payment_choice: 'deposit',
    payment_distribution: quoteResult.per_guest_deposits || [],
  });
  const receipt = {
    ok: true, source: 'staff_pricing', quoteRevision: offer.offer_revision.offer_fingerprint,
    selectionRevision: current.provenance.availability_fingerprint, expiresAt: null,
    totalCents: quoteResult.total_cents, depositCents: quoteResult.deposit_required_cents,
    remainingCents: quoteResult.balance_due_cents, currency: quoteResult.currency,
    lineItems: quoteResult.line_items, perPerson: quoteResult.per_guest_deposits || [],
    eligibilityFacts: { packageEligible: quoteResult.package_eligible, blockers: quoteResult.blockers || [] },
  };
  const assignments = selectedBeds.map((bedCode, index) => ({
    bed_code: bedCode,
    guest_name: input.guests[index] && input.guests[index].name,
    package_code: ((input.guest_packages || []).find((p) => Number(p.guest_number) === index + 1) || {}).package_code || input.package_id || 'package_none',
  }));
  await pg.query(`INSERT INTO luna_v3_selections(client_id,session_id,quote_revision,check_in,check_out,guests,assignments,quote)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb)
    ON CONFLICT(client_id,session_id,quote_revision) DO NOTHING`, [session.client_id, session.id,
    receipt.quoteRevision, input.check_in, input.check_out, JSON.stringify(input.guests), JSON.stringify(assignments),
    JSON.stringify({ ...receipt, phone: context.guestPhone || null, quoteInput: input,
      packageCode: input.package_id || null, roomType: input.selection.room_type || 'shared',
      keepTogether: input.selection.keep_together === true })]);
  return { ...receipt, quotedSelection: receipt.quoteRevision };
}

function createOperations(withPgClient) {
  return Object.freeze(Object.fromEntries(Object.entries(WIRES).map(([name, wire]) => [wire,
    (input, context) => withPgClient((client) => module.exports[name](client, input, context)),
  ])));
}

module.exports = { checkAvailability, findRooms, getPricingCatalog, quote, ...v3, createOperations };
