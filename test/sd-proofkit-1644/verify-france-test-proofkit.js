#!/usr/bin/env node
'use strict';

/**
 * SD-PROOFKIT-1644 offline receipt verifier.
 *
 * It never contacts a service, sends WhatsApp, or reads credentials. Bug Finder
 * supplies a transient receipt directory from the separately authorized France
 * TEST run. The verifier checks the closed 18-chat matrix and the three state
 * transitions. It intentionally keeps guest wording out of fixtures: the only
 * text comparison is against the checked-in guest catalog loaded at run time.
 *
 * Run:
 *   node test/sd-proofkit-1644/verify-france-test-proofkit.js --receipts /secure/path
 *   node test/sd-proofkit-1644/verify-france-test-proofkit.js --self-test
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SCENARIOS = JSON.parse(fs.readFileSync(path.join(__dirname, 'france-test-scenarios.json'), 'utf8'));
const CATALOG = JSON.parse(fs.readFileSync(path.join(ROOT, 'docker/hermes-staging/wolfhouse/guest_copy.json'), 'utf8'));
const expectedCases = new Map(SCENARIOS.cases.map(c => [c.id, c]));
const expectedStates = new Set(SCENARIOS.state_cases.map(c => c.id));
const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const httpsUrl = /^https:\/\/.+/i;

function fail(message) { throw new Error(message); }
function sha(value) { return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex'); }
function flattenStrings(value, out = []) {
  if (typeof value === 'string' && value.trim()) out.push(value.trim());
  else if (Array.isArray(value)) value.forEach(item => flattenStrings(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => flattenStrings(item, out));
  return out;
}
const catalogLines = new Set(flattenStrings(CATALOG.locales));
function eqArray(a, b) { return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]); }
function dateWithDots(value) {
  if (!isoDate.test(value)) fail(`invalid ISO date: ${value}`);
  const [year, month, day] = value.split('-');
  return `${day}.${month}.${year}`;
}
function positiveInt(value) { return Number.isInteger(value) && value > 0; }
function nonNegativeInt(value) { return Number.isInteger(value) && value >= 0; }
function readReceipts(dir) {
  if (!dir || !path.isAbsolute(dir)) fail('--receipts must be an absolute, private receipt directory');
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) fail('--receipts is not a directory');
  return fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort().map(name => {
    const item = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    item.__file = name;
    return item;
  });
}
function requireTestScope(receipt) {
  assert.equal(receipt.environment, 'france-test', `${receipt.__file}: not France TEST`);
  assert.equal(receipt.tenant, 'wolfhouse-somo', `${receipt.__file}: wrong tenant`);
  assert.equal(receipt.production, false, `${receipt.__file}: production receipt refused`);
  assert.equal(receipt.outbound_live_whatsapp, false, `${receipt.__file}: live outbound receipt refused`);
}
function verifyBooking(receipt, scenario) {
  const b = receipt.booking || {};
  const c = receipt.confirmation || {};
  assert.equal(b.found_in_staff, true, `${scenario.id}: booking not found in TEST Staff`);
  assert.ok(typeof b.reference === 'string' && b.reference.length, `${scenario.id}: booking reference missing`);
  assert.ok(eqArray(b.names, c.names) && b.names.length, `${scenario.id}: confirmation names mismatch`);
  assert.ok(isoDate.test(b.check_in) && isoDate.test(b.check_out), `${scenario.id}: booking dates invalid`);
  assert.equal(c.check_in, b.check_in, `${scenario.id}: confirmation check-in mismatch`);
  assert.equal(c.check_out, b.check_out, `${scenario.id}: confirmation check-out mismatch`);
  assert.equal(c.reference, b.reference, `${scenario.id}: confirmation reference mismatch`);
  assert.equal(b.room_type, scenario.room_type, `${scenario.id}: Staff room type differs from scenario`);
  assert.equal(c.room_type, b.room_type, `${scenario.id}: confirmation room type mismatch`);
  assert.ok(positiveInt(b.total_cents), `${scenario.id}: booking total invalid`);
  assert.ok(nonNegativeInt(b.deposit_cents) && b.deposit_cents <= b.total_cents, `${scenario.id}: booking deposit invalid`);
  assert.equal(c.total_cents, b.total_cents, `${scenario.id}: confirmation total mismatch`);
  assert.equal(c.deposit_cents, b.deposit_cents, `${scenario.id}: confirmation deposit mismatch`);
  assert.ok(httpsUrl.test(b.payment_link), `${scenario.id}: booking payment link invalid`);
  assert.equal(c.payment_link, b.payment_link, `${scenario.id}: confirmation payment link mismatch`);
  assert.equal(c.received, true, `${scenario.id}: confirmation absent`);
  assert.equal(receipt.guest_acceptance && receipt.guest_acceptance.payment_choice_turns, 1, `${scenario.id}: payment acceptance must occur exactly once`);
  assert.equal(receipt.guest_acceptance && receipt.guest_acceptance.extra_save_confirmation, false, `${scenario.id}: extra save confirmation present`);
}
function verifyCopy(receipt, scenario) {
  const c = receipt.confirmation || {};
  const audit = receipt.copy_audit || {};
  assert.ok(Array.isArray(c.outgoing_messages) && c.outgoing_messages.length, `${scenario.id}: outgoing capture missing`);
  assert.ok(Array.isArray(audit.outgoing_message_hashes), `${scenario.id}: outgoing hashes missing`);
  assert.equal(audit.catalog_path, 'docker/hermes-staging/wolfhouse/guest_copy.json', `${scenario.id}: wrong catalog owner`);
  assert.ok(Array.isArray(audit.fixed_line_ids), `${scenario.id}: fixed-line IDs missing`);
  for (const message of c.outgoing_messages) {
    assert.ok(typeof message === 'string' && message.trim(), `${scenario.id}: empty outgoing message`);
    assert.ok(audit.outgoing_message_hashes.includes(sha(message)), `${scenario.id}: outgoing hash receipt mismatch`);
    assert.equal(catalogLines.has(message.trim()), false, `${scenario.id}: whole reply equals catalog copy`);
  }
}
function verifyGerman(receipt, scenario) {
  if (scenario.language !== 'de') return;
  const quality = receipt.german_quality || {};
  assert.equal(quality.register_consistent, true, `${scenario.id}: German register consistency failed`);
  assert.ok(Array.isArray(quality.registers) && quality.registers.length === 1, `${scenario.id}: German register analyzer must report exactly one register`);
  const messages = receipt.confirmation.outgoing_messages.join('\n');
  const dates = quality.date_values || [receipt.booking.check_in, receipt.booking.check_out];
  assert.ok(Array.isArray(dates) && dates.length, `${scenario.id}: German date evidence absent`);
  for (const value of dates) assert.ok(messages.includes(dateWithDots(value)), `${scenario.id}: German date lacks dot format for ${value}`);
}
function verifyState(receipt) {
  const id = receipt.case_id;
  const check = receipt.state || {};
  if (id === 'SD1644-CLEAR-ATOMIC') {
    for (const key of ['cleared_at_persisted', 'thread_empty_after_refresh', 'history_retained', 'needs_human_false', 'hold_false', 'luna_toggle_on', 'next_inbound_reply_generated']) assert.equal(check[key], true, `${id}: ${key} required`);
  } else if (id === 'SD1644-PAYLINK-FAIL-KEEPS-TALKING') {
    for (const key of ['payment_link_failure_forced', 'needs_human_false', 'hold_false', 'luna_toggle_on', 'retry_or_recovery_reply_generated']) assert.equal(check[key], true, `${id}: ${key} required`);
  } else if (id === 'SD1644-REAL-HANDOVER-SILENT') {
    for (const key of ['real_handover', 'staff_luna_paused_banner', 'no_reply_generated_while_held', 'no_suppressed_send_log', 'resume_lifts_hold', 'clear_lifts_hold']) assert.equal(check[key], true, `${id}: ${key} required`);
  } else fail(`unknown state receipt ${id}`);
}
function verify(receipts) {
  const ids = new Set();
  const seenCases = new Set(); const seenStates = new Set();
  for (const receipt of receipts) {
    requireTestScope(receipt);
    assert.ok(typeof receipt.case_id === 'string' && receipt.case_id.length, `${receipt.__file}: case_id missing`);
    assert.equal(ids.has(receipt.case_id), false, `${receipt.case_id}: duplicate receipt`); ids.add(receipt.case_id);
    const scenario = expectedCases.get(receipt.case_id);
    if (scenario) {
      verifyBooking(receipt, scenario); verifyCopy(receipt, scenario); verifyGerman(receipt, scenario); seenCases.add(scenario.id);
    } else if (expectedStates.has(receipt.case_id)) {
      verifyState(receipt); seenStates.add(receipt.case_id);
    } else fail(`${receipt.case_id}: not an allowlisted proof-kit case`);
  }
  assert.deepEqual([...seenCases].sort(), [...expectedCases.keys()].sort(), 'matrix must contain every closed booking case exactly once');
  assert.deepEqual([...seenStates].sort(), [...expectedStates].sort(), 'matrix must contain every required state proof exactly once');
  return { booking_cases: seenCases.size, state_cases: seenStates.size, catalog_lines: catalogLines.size };
}
function selfTest() {
  const receipts = SCENARIOS.cases.map((scenario, index) => {
    const checkIn = `2027-0${(index % 8) + 1}-10`; const checkOut = `2027-0${(index % 8) + 1}-13`;
    const message = scenario.language === 'de' ? `generated ${dateWithDots(checkIn)} ${dateWithDots(checkOut)}` : `generated case ${scenario.id}`;
    const booking = { found_in_staff: true, reference: `TEST-${index}`, names: ['QA'], check_in: checkIn, check_out: checkOut, room_type: scenario.room_type, total_cents: 10000, deposit_cents: 2500, payment_link: `https://example.test/${index}` };
    return { __file: `${scenario.id}.json`, case_id: scenario.id, environment: 'france-test', tenant: 'wolfhouse-somo', production: false, outbound_live_whatsapp: false, booking, confirmation: { received: true, ...booking, outgoing_messages: [message] }, guest_acceptance: { payment_choice_turns: 1, extra_save_confirmation: false }, copy_audit: { catalog_path: 'docker/hermes-staging/wolfhouse/guest_copy.json', fixed_line_ids: [], outgoing_message_hashes: [sha(message)] }, german_quality: { register_consistent: true, registers: ['single'], date_values: [checkIn, checkOut] } };
  });
  for (const state of SCENARIOS.state_cases) receipts.push({ __file: `${state.id}.json`, case_id: state.id, environment: 'france-test', tenant: 'wolfhouse-somo', production: false, outbound_live_whatsapp: false, state: { payment_link_failure_forced: true, cleared_at_persisted: true, thread_empty_after_refresh: true, history_retained: true, needs_human_false: true, hold_false: true, luna_toggle_on: true, next_inbound_reply_generated: true, retry_or_recovery_reply_generated: true, real_handover: true, staff_luna_paused_banner: true, no_reply_generated_while_held: true, no_suppressed_send_log: true, resume_lifts_hold: true, clear_lifts_hold: true } });
  return verify(receipts);
}
const arg = process.argv.slice(2);
try {
  const result = arg.includes('--self-test') ? selfTest() : verify(readReceipts(arg[arg.indexOf('--receipts') + 1]));
  console.log(`PASS SD-PROOFKIT-1644 — ${result.booking_cases} booking cases, ${result.state_cases} state cases, catalog=${result.catalog_lines}`);
} catch (error) {
  console.error(`FAIL SD-PROOFKIT-1644 — ${error.message}`);
  process.exitCode = 1;
}
