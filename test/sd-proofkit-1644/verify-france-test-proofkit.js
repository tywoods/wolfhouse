#!/usr/bin/env node
'use strict';

/**
 * SD-PROOFKIT-1644 offline France TEST receipt verifier.
 *
 * No network, credentials, sends, or guest-copy dependency. Receipts contain the
 * actual outgoing messages. For every booking fact, fact_spans point into those
 * messages; the verifier extracts each span and compares it to TEST Staff truth.
 *
 * Run:
 *   node test/sd-proofkit-1644/verify-france-test-proofkit.js --receipts /private/dir
 *   node test/sd-proofkit-1644/verify-france-test-proofkit.js --self-test
 *   node test/sd-proofkit-1644/verify-france-test-proofkit.js --negative-test
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const SCENARIOS = JSON.parse(fs.readFileSync(path.join(__dirname, 'france-test-scenarios.json'), 'utf8'));
const expectedCases = new Map(SCENARIOS.cases.map(c => [c.id, c]));
const expectedStates = new Set(SCENARIOS.state_cases.map(c => c.id));
const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const httpsUrl = /^https:\/\/.+/i;

function fail(message) { throw new Error(message); }
function sha(value) { return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex'); }
function eqArray(a, b) { return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]); }
function dateWithDots(value) { if (!isoDate.test(value)) fail(`invalid ISO date: ${value}`); const [y, m, d] = value.split('-'); return `${d}.${m}.${y}`; }
function positiveInt(value) { return Number.isInteger(value) && value > 0; }
function nonNegativeInt(value) { return Number.isInteger(value) && value >= 0; }
function readReceipts(dir) {
  if (!dir || !path.isAbsolute(dir)) fail('--receipts must be an absolute, private receipt directory');
  if (!fs.statSync(dir).isDirectory()) fail('--receipts is not a directory');
  return fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort().map(name => ({ ...JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')), __file: name }));
}
function requireTestScope(receipt) {
  assert.equal(receipt.environment, 'france-test', `${receipt.__file}: not France TEST`);
  assert.equal(receipt.tenant, 'wolfhouse-somo', `${receipt.__file}: wrong tenant`);
  assert.equal(receipt.production, false, `${receipt.__file}: production receipt refused`);
  assert.equal(receipt.outbound_live_whatsapp, false, `${receipt.__file}: live outbound receipt refused`);
}
function moneyCents(text) {
  const raw = String(text).trim().replace(/[−–—]/g, '-').replace(/[^0-9,+.-]/g, '');
  if (!raw || !/^[+-]?[0-9][0-9,.-]*$/.test(raw)) return null;
  const sign = raw.startsWith('-') ? -1 : 1; const numeric = raw.replace(/^[+-]/, '');
  const lastComma = numeric.lastIndexOf(','); const lastDot = numeric.lastIndexOf('.'); const sep = Math.max(lastComma, lastDot);
  if (sep < 0) return /^\d+$/.test(numeric) ? sign * Number(numeric) * 100 : null;
  const whole = numeric.slice(0, sep).replace(/[^0-9]/g, ''); const fraction = numeric.slice(sep + 1).replace(/[^0-9]/g, '');
  if (!whole || !/^\d{1,2}$/.test(fraction)) return null;
  return sign * (Number(whole) * 100 + Number(fraction.padEnd(2, '0')));
}
function spanText(messages, span, label) {
  assert.ok(span && Number.isInteger(span.message_index) && Number.isInteger(span.start) && Number.isInteger(span.end), `${label}: invalid fact span`);
  const message = messages[span.message_index];
  assert.ok(typeof message === 'string' && span.start >= 0 && span.end > span.start && span.end <= message.length, `${label}: span outside actual outgoing message`);
  return message.slice(span.start, span.end);
}
function requiredFactKeys(b) {
  const keys = ['reference', 'room', 'check_in', 'check_out', 'nights', 'package', 'total', 'deposit', 'paid_now', 'balance', 'balance_due_at', 'payment_link'];
  for (let i = 0; i < b.names.length; i += 1) keys.push(`name:${i}`);
  return keys;
}
function factMatches(field, text, b) {
  if (field === 'reference') return text === b.reference;
  if (field === 'room') return text.trim().toLocaleLowerCase() === b.room_label.trim().toLocaleLowerCase();
  if (field === 'package') return text.trim().toLocaleLowerCase() === b.package_label.trim().toLocaleLowerCase();
  if (field === 'payment_link') return text === b.payment_link;
  if (field === 'check_in' || field === 'check_out' || field === 'balance_due_at') return [b[field], dateWithDots(b[field])].includes(text);
  if (field === 'nights') return Number(text.replace(/[^0-9]/g, '')) === b.nights;
  if (field === 'total' || field === 'deposit' || field === 'paid_now' || field === 'balance') return moneyCents(text) === b[`${field}_cents`];
  const match = /^name:(\d+)$/.exec(field);
  return !!match && text === b.names[Number(match[1])];
}
function verifyWholeClaimReading(receipt, scenario) {
  const b = receipt.booking; const c = receipt.confirmation; const reading = c.claim_reading || {};
  assert.deepEqual(reading.source_message_hashes, c.outgoing_messages.map(sha), `${scenario.id}: claim reading must cover every actual outgoing message`);
  assert.ok(Array.isArray(reading.money) && Array.isArray(reading.participants) && Array.isArray(reading.rooms), `${scenario.id}: complete claim reading missing`);
  const expectedMoney = { total: b.total_cents, deposit: b.deposit_cents, paid_now: b.paid_now_cents, balance: b.balance_cents };
  for (const claim of reading.money) { assert.ok(Object.hasOwn(expectedMoney, claim.role) && Number.isInteger(claim.cents) && typeof claim.asserted === 'boolean', `${scenario.id}: invalid money claim`); if (claim.asserted) assert.equal(claim.cents, expectedMoney[claim.role], `${scenario.id}: contradictory ${claim.role} claim`); else assert.notEqual(claim.cents, expectedMoney[claim.role], `${scenario.id}: denial of real ${claim.role} claim`); }
  for (const claim of reading.participants) assert.ok(typeof claim.name === 'string' && typeof claim.asserted === 'boolean', `${scenario.id}: invalid participant claim`);
  for (const claim of reading.participants.filter(c => !c.asserted)) assert.equal(b.names.includes(claim.name), false, `${scenario.id}: denial of real participant claim`);
  const assertedNames = reading.participants.filter(c => c.asserted).map(c => c.name).sort();
  assert.deepEqual(assertedNames, [...b.names].sort(), `${scenario.id}: participant claims differ from booking`);
  for (const claim of reading.rooms) { assert.ok(['shared', 'private'].includes(claim.room_type) && typeof claim.asserted === 'boolean', `${scenario.id}: invalid room claim`); if (claim.asserted) assert.equal(claim.room_type, b.room_type, `${scenario.id}: contradictory room claim`); else assert.notEqual(claim.room_type, b.room_type, `${scenario.id}: denial of real room claim`); }
  assert.ok(Array.isArray(reading.facts), `${scenario.id}: complete claim reading facts missing`);
  for (const claim of reading.facts) { assert.ok(['reference', 'check_in', 'check_out'].includes(claim.field) && typeof claim.value === 'string' && typeof claim.asserted === 'boolean', `${scenario.id}: invalid factual claim`); const isReal = factMatches(claim.field, claim.value, b); if (claim.asserted) assert.equal(isReal, true, `${scenario.id}: contradictory ${claim.field} claim`); else assert.equal(isReal, false, `${scenario.id}: denial of real ${claim.field} claim`); }
}
function verifyWholeOutgoingText(receipt, scenario) {
  const b = receipt.booking; const c = receipt.confirmation; const text = c.outgoing_messages.join('\n');
  assert.ok(Array.isArray(b.fixed_copy_fragments), `${scenario.id}: TEST record fixed-copy detector missing`);
  for (const fragment of b.fixed_copy_fragments) { assert.ok(typeof fragment === 'string' && fragment, `${scenario.id}: invalid TEST record fixed-copy fragment`); assert.equal(text.includes(fragment), false, `${scenario.id}: known fixed-copy wording found in outgoing text`); }
  verifyWholeClaimReading(receipt, scenario);
  for (const url of text.match(/https:\/\/[^\s<>()]+/gi) || []) assert.equal(url, b.payment_link, `${scenario.id}: contradictory payment link anywhere in outgoing text`);
}
function verifyActualOutgoingFacts(receipt, scenario) {
  const b = receipt.booking; const c = receipt.confirmation; const messages = c.outgoing_messages;
  const required = requiredFactKeys(b); const spans = c.fact_spans || {}; const observed = c.observed_facts;
  assert.deepEqual(Object.keys(spans).sort(), [...required].sort(), `${scenario.id}: fact_spans must cover every required fact`);
  assert.ok(Array.isArray(observed) && observed.length >= required.length, `${scenario.id}: whole-message observed_facts missing`);
  const seenPrimary = new Set();
  for (const [field, span] of Object.entries(spans)) {
    const text = spanText(messages, span, `${scenario.id}: ${field}`);
    assert.ok(factMatches(field, text, b), `${scenario.id}: actual outgoing ${field} mismatch`);
    seenPrimary.add(`${field}|${span.message_index}|${span.start}|${span.end}`);
  }
  const seenFields = new Set();
  for (const observation of observed) {
    assert.ok(observation && required.includes(observation.field), `${scenario.id}: unknown observed fact field`);
    const text = spanText(messages, observation, `${scenario.id}: observed ${observation.field}`);
    assert.ok(factMatches(observation.field, text, b), `${scenario.id}: contradictory ${observation.field} anywhere in outgoing text`);
    seenFields.add(observation.field);
  }
  assert.deepEqual([...seenFields].sort(), [...required].sort(), `${scenario.id}: observed_facts must include every required fact`);
  for (const primary of seenPrimary) assert.ok(observed.some(o => `${o.field}|${o.message_index}|${o.start}|${o.end}` === primary), `${scenario.id}: primary span absent from whole-message observations`);
}
function verifyBooking(receipt, scenario) {
  const b = receipt.booking || {}; const c = receipt.confirmation || {};
  assert.equal(b.found_in_staff, true, `${scenario.id}: booking not found in TEST Staff`);
  assert.ok(typeof b.reference === 'string' && b.reference.length, `${scenario.id}: booking reference missing`);
  assert.ok(Array.isArray(b.names) && b.names.length === b.party_size && b.names.every(n => typeof n === 'string' && n), `${scenario.id}: every booking participant name required`);
  assert.ok(isoDate.test(b.check_in) && isoDate.test(b.check_out), `${scenario.id}: booking dates invalid`);
  assert.equal(b.room_type, scenario.room_type, `${scenario.id}: Staff room type differs from scenario`);
  assert.equal(b.package_included, scenario.package, `${scenario.id}: Staff package dimension differs from scenario`);
  assert.equal(b.payment_choice, scenario.payment, `${scenario.id}: Staff payment dimension differs from scenario`);
  assert.ok(Number.isInteger(b.party_size) && (scenario.party === 'solo' ? b.party_size === 1 : scenario.party === 'couple' ? b.party_size === 2 : b.party_size >= 3), `${scenario.id}: Staff party dimension differs from scenario`);
  assert.ok(typeof b.room_label === 'string' && b.room_label.trim(), `${scenario.id}: Staff room label missing`);
  assert.ok(positiveInt(b.nights), `${scenario.id}: booking nights invalid`);
  assert.ok(typeof b.package_label === 'string' && b.package_label.trim(), `${scenario.id}: Staff package label missing`);
  assert.ok(positiveInt(b.total_cents), `${scenario.id}: booking total invalid`);
  assert.ok(nonNegativeInt(b.deposit_cents) && b.deposit_cents <= b.total_cents, `${scenario.id}: booking deposit invalid`);
  assert.ok(nonNegativeInt(b.paid_now_cents) && b.paid_now_cents <= b.total_cents, `${scenario.id}: booking paid-now invalid`);
  assert.ok(nonNegativeInt(b.balance_cents) && b.balance_cents <= b.total_cents, `${scenario.id}: booking balance invalid`);
  assert.equal(b.paid_now_cents + b.balance_cents, b.total_cents, `${scenario.id}: paid-now + balance must equal total`);
  assert.ok(isoDate.test(b.balance_due_at), `${scenario.id}: balance due date invalid`);
  assert.ok(httpsUrl.test(b.payment_link), `${scenario.id}: booking payment link invalid`);
  assert.equal(c.received, true, `${scenario.id}: confirmation absent`);
  assert.equal(c.delivered, true, `${scenario.id}: confirmation accepted but not delivered`);
  assert.ok(Array.isArray(c.outgoing_messages) && c.outgoing_messages.length, `${scenario.id}: actual outgoing capture missing`);
  assert.ok(Array.isArray(c.outgoing_message_hashes) && Array.isArray(c.delivered_message_hashes), `${scenario.id}: outgoing delivery evidence missing`);
  for (const message of c.outgoing_messages) { assert.ok(c.outgoing_message_hashes.includes(sha(message)), `${scenario.id}: outgoing hash mismatch`); assert.ok(c.delivered_message_hashes.includes(sha(message)), `${scenario.id}: accepted outgoing message not delivered`); }
  verifyWholeOutgoingText(receipt, scenario);
  verifyActualOutgoingFacts(receipt, scenario);
  assert.equal(receipt.guest_acceptance && receipt.guest_acceptance.payment_choice_turns, 1, `${scenario.id}: payment acceptance must occur exactly once`);
  assert.equal(receipt.guest_acceptance && receipt.guest_acceptance.extra_save_confirmation, false, `${scenario.id}: extra save confirmation present`);
}
function verifyGerman(receipt, scenario) {
  if (scenario.language !== 'de') return;
  const quality = receipt.german_quality || {}; const messages = receipt.confirmation.outgoing_messages.join('\n');
  assert.equal(quality.register_consistent, true, `${scenario.id}: German register consistency failed`);
  assert.ok(Array.isArray(quality.registers) && quality.registers.length === 1, `${scenario.id}: German register analyzer must report exactly one register`);
  for (const value of [receipt.booking.check_in, receipt.booking.check_out]) assert.ok(messages.includes(dateWithDots(value)), `${scenario.id}: real German booking date lacks dot format for ${value}`);
}
function verifyState(receipt) {
  const check = receipt.state || {}; const required = receipt.case_id === 'SD1644-CLEAR-ATOMIC' ? ['cleared_at_persisted', 'thread_empty_after_refresh', 'history_retained', 'needs_human_false', 'hold_false', 'luna_toggle_on', 'next_inbound_reply_generated'] : receipt.case_id === 'SD1644-PAYLINK-FAIL-KEEPS-TALKING' ? ['payment_link_failure_forced', 'needs_human_false', 'hold_false', 'luna_toggle_on', 'retry_or_recovery_reply_generated'] : ['real_handover', 'staff_luna_paused_banner', 'no_reply_generated_while_held', 'no_suppressed_send_log', 'resume_lifts_hold', 'clear_lifts_hold'];
  required.forEach(key => assert.equal(check[key], true, `${receipt.case_id}: ${key} required`));
  if (receipt.case_id === 'SD1644-CLEAR-ATOMIC') {
    assert.ok(typeof check.atomic_operation_id === 'string' && check.atomic_operation_id, `${receipt.case_id}: atomic operation id missing`);
    assert.deepEqual(check.atomic_effect_operation_ids, { cleared_at: check.atomic_operation_id, needs_human: check.atomic_operation_id, hold: check.atomic_operation_id, luna_toggle: check.atomic_operation_id }, `${receipt.case_id}: Clear effects were not all-in-one`);
  }
}
function verify(receipts) {
  const ids = new Set(); const bookingReferences = new Set(); const seenCases = new Set(); const seenStates = new Set();
  for (const receipt of receipts) {
    requireTestScope(receipt); assert.ok(typeof receipt.case_id === 'string' && receipt.case_id, `${receipt.__file}: case_id missing`); assert.equal(ids.has(receipt.case_id), false, `${receipt.case_id}: duplicate receipt`); ids.add(receipt.case_id);
    const scenario = expectedCases.get(receipt.case_id);
    if (scenario) { assert.equal(bookingReferences.has(receipt.booking && receipt.booking.reference), false, `${scenario.id}: reused TEST Staff booking reference`); bookingReferences.add(receipt.booking && receipt.booking.reference); verifyBooking(receipt, scenario); verifyGerman(receipt, scenario); seenCases.add(scenario.id); } else if (expectedStates.has(receipt.case_id)) { verifyState(receipt); seenStates.add(receipt.case_id); } else fail(`${receipt.case_id}: not an allowlisted proof-kit case`);
  }
  assert.deepEqual([...seenCases].sort(), [...expectedCases.keys()].sort(), 'matrix must contain every closed booking case exactly once');
  assert.deepEqual([...seenStates].sort(), [...expectedStates].sort(), 'matrix must contain every required state proof exactly once');
  return { booking_cases: seenCases.size, state_cases: seenStates.size };
}
function bookingReceipt(scenario, index) {
  const checkIn = `2027-0${(index % 8) + 1}-10`; const checkOut = `2027-0${(index % 8) + 1}-13`; const due = checkIn; const roomLabel = scenario.room_type; const packageLabel = scenario.package ? 'package' : 'stay'; const ref = `TEST-${index}`; const name = 'QA'; const link = `https://example.test/${index}`;
  const dates = scenario.language === 'de' ? [dateWithDots(checkIn), dateWithDots(checkOut), dateWithDots(due)] : [checkIn, checkOut, due];
  const partySize = scenario.party === 'solo' ? 1 : scenario.party === 'couple' ? 2 : 3; const names = Array.from({ length: partySize }, (_, i) => `QA${i + 1}`);
  const facts = [ref, ...names, roomLabel, dates[0], dates[1], '3', packageLabel, '100.00', '25.00', '25.00', '75.00', dates[2], link]; const message = facts.join(' | '); let cursor = 0; const locate = value => { const start = message.indexOf(value, cursor); cursor = start + value.length; return { message_index: 0, start, end: cursor }; };
  const fact_spans = { reference: locate(ref) }; names.forEach((name, i) => { fact_spans[`name:${i}`] = locate(name); }); Object.assign(fact_spans, { room: locate(roomLabel), check_in: locate(dates[0]), check_out: locate(dates[1]), nights: locate('3'), package: locate(packageLabel), total: locate('100.00'), deposit: locate('25.00'), paid_now: locate('25.00'), balance: locate('75.00'), balance_due_at: locate(dates[2]), payment_link: locate(link) });
  const booking = { found_in_staff: true, reference: ref, names, check_in: checkIn, check_out: checkOut, room_type: scenario.room_type, party_size: partySize, package_included: scenario.package, payment_choice: scenario.payment, room_label: roomLabel, nights: 3, package_label: packageLabel, fixed_copy_fragments: [], total_cents: 10000, deposit_cents: 2500, paid_now_cents: 2500, balance_cents: 7500, balance_due_at: due, payment_link: link };
  const observed_facts = Object.entries(fact_spans).map(([field, span]) => ({ field, ...span }));
  const claim_reading = { source_message_hashes: [sha(message)], money: [{ role: 'total', cents: 10000, asserted: true }, { role: 'deposit', cents: 2500, asserted: true }, { role: 'paid_now', cents: 2500, asserted: true }, { role: 'balance', cents: 7500, asserted: true }], participants: names.map(name => ({ name, asserted: true })), rooms: [{ room_type: scenario.room_type, asserted: true }], facts: [{ field: 'reference', value: ref, asserted: true }, { field: 'check_in', value: dates[0], asserted: true }, { field: 'check_out', value: dates[1], asserted: true }] };
  return { __file: `${scenario.id}.json`, case_id: scenario.id, environment: 'france-test', tenant: 'wolfhouse-somo', production: false, outbound_live_whatsapp: false, booking, confirmation: { received: true, delivered: true, outgoing_messages: [message], outgoing_message_hashes: [sha(message)], delivered_message_hashes: [sha(message)], fact_spans, observed_facts, claim_reading }, guest_acceptance: { payment_choice_turns: 1, extra_save_confirmation: false }, german_quality: { register_consistent: true, registers: ['single'], date_values: [checkIn, checkOut] } };
}
function states() { return SCENARIOS.state_cases.map(state => ({ __file: `${state.id}.json`, case_id: state.id, environment: 'france-test', tenant: 'wolfhouse-somo', production: false, outbound_live_whatsapp: false, state: { payment_link_failure_forced: true, cleared_at_persisted: true, thread_empty_after_refresh: true, history_retained: true, needs_human_false: true, hold_false: true, luna_toggle_on: true, next_inbound_reply_generated: true, retry_or_recovery_reply_generated: true, real_handover: true, staff_luna_paused_banner: true, no_reply_generated_while_held: true, no_suppressed_send_log: true, resume_lifts_hold: true, clear_lifts_hold: true, atomic_operation_id: 'clear-atomically', atomic_effect_operation_ids: { cleared_at: 'clear-atomically', needs_human: 'clear-atomically', hold: 'clear-atomically', luna_toggle: 'clear-atomically' } } })); }
function selfTest() { return verify([...SCENARIOS.cases.map(bookingReceipt), ...states()]); }
function negativeTest() {
  const missing = [...SCENARIOS.cases.map(bookingReceipt), ...states()]; delete missing[0].confirmation.claim_reading; assert.throws(() => verify(missing), /claim reading must cover|complete claim reading/);
  const duplicateTotal = [...SCENARIOS.cases.map(bookingReceipt), ...states()]; duplicateTotal[0].confirmation.outgoing_messages.push('second confirmation'); duplicateTotal[0].confirmation.outgoing_message_hashes.push(sha('second confirmation')); duplicateTotal[0].confirmation.delivered_message_hashes.push(sha('second confirmation')); duplicateTotal[0].confirmation.claim_reading.source_message_hashes.push(sha('second confirmation')); duplicateTotal[0].confirmation.claim_reading.money.push({ role: 'total', cents: 99900, asserted: true }); assert.throws(() => verify(duplicateTotal), /contradictory total claim/);
  const wrongName = [...SCENARIOS.cases.map(bookingReceipt), ...states()]; wrongName[0].confirmation.claim_reading.participants.push({ name: 'Morgan', asserted: true }); assert.throws(() => verify(wrongName), /participant claims differ/);
  const wrongRoom = [...SCENARIOS.cases.map(bookingReceipt), ...states()]; wrongRoom[0].confirmation.claim_reading.rooms.push({ room_type: 'private', asserted: true }); assert.throws(() => verify(wrongRoom), /contradictory room claim/);
  const negatedRoom = [...SCENARIOS.cases.map(bookingReceipt), ...states()]; negatedRoom[0].confirmation.claim_reading.rooms.push({ room_type: 'private', asserted: false }); assert.doesNotThrow(() => verify(negatedRoom), 'negated alternative room is not a positive room claim');
  const denial = [...SCENARIOS.cases.map(bookingReceipt), ...states()]; denial[0].confirmation.claim_reading.money.push({ role: 'total', cents: 10000, asserted: false }); assert.throws(() => verify(denial), /denial of real total claim/);
  const deniedReference = [...SCENARIOS.cases.map(bookingReceipt), ...states()]; deniedReference[0].confirmation.claim_reading.facts.push({ field: 'reference', value: deniedReference[0].booking.reference, asserted: false }); assert.throws(() => verify(deniedReference), /denial of real reference claim/);
  assert.equal(moneyCents('−100.0'), -10000, 'Unicode minus must be preserved'); assert.notEqual(moneyCents('−100.0'), 10000, 'Unicode negative amount must not match positive cents');
  return { rejected: 'complete-reading gaps; duplicate total; wrong participant; positive room claim; Unicode negative money' };
}
const arg = process.argv.slice(2);
try { const result = arg.includes('--self-test') ? selfTest() : arg.includes('--negative-test') ? negativeTest() : verify(readReceipts(arg[arg.indexOf('--receipts') + 1])); console.log(`PASS SD-PROOFKIT-1644 — ${result.booking_cases || 18} booking cases, ${result.state_cases || 3} state cases${result.rejected ? `; negative rejected: ${result.rejected}` : ''}`); } catch (error) { console.error(`FAIL SD-PROOFKIT-1644 — ${error.message}`); process.exitCode = 1; }
