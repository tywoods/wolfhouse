'use strict';

// Luna v3 offline contracts. Handler tests stay pending until Skip's
// scripts/lib/model-led-luna/ exists AND an awaited call leaves state the
// verifier reads back itself. A missing handler is not a pass. A function
// that merely exists, or returns a success shape without touching the
// observation DB, is not a pass.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const fixtureDir = path.join(repoRoot, 'fixtures', 'luna-v3', 'acceptance');
const handlerRoot = path.join(repoRoot, 'scripts', 'lib', 'model-led-luna');
const handlerIndex = path.join(handlerRoot, 'index.js');

const REQUIRED_SCRIPTS = [
  'guest-01-couple.json',
  'guest-01-room10-only.json',
  'guest-02-solo-package.json',
  'guest-03-mixed-group.json',
  'guest-04-refusal.json',
  'guest-05-lifecycle.json',
];

const REFUSAL_INTEREST_GUEST = 'If a later week in 2027 has one room for both of us, we will take that instead.';
const REFUSAL_ACCEPT_GUEST = 'Yes, we accept the fresh quote for 21 to 25 August 2027, both of us in that same room. Book that quote only.';
const LIFECYCLE_SETUP_GUEST = 'Please make the first booking for Casey, one person, 3 September to 7 September 2027, and bind this chat to that saved record.';
const LIFECYCLE_COMPLETE_GUEST = 'I completed the sandbox payment on the test link. No real card was charged. Confirm only after Staff says it is paid.';
const LIFECYCLE_TIMEOUT_GUEST = 'getPaymentStatus timed out after the sandbox checkout and before you confirmed paid. Read that same booking back and retry only that call.';

const HANDLER_CONTRACTS = [
  {
    id: 'hold_all_or_none',
    exportName: 'holdBeds',
    todo: 'TODO(skip): holdBeds must persist every requested bed or none, including a race with an ordinary Staff writer',
    judge: judgeHoldAllOrNone,
  },
  {
    id: 'no_bed_substitution',
    exportName: 'holdBeds',
    todo: 'TODO(skip): holdBeds must not swap in a different bed or room when the requested one is unavailable',
    judge: judgeNoSubstitution,
  },
  {
    id: 'staff_computed_money',
    exportName: 'quote',
    todo: 'TODO(skip): quote must return Staff Pricing cents and reject a model-supplied amount',
    judge: judgeStaffMoney,
  },
  {
    id: 'cancel_unpaid_refuses_paid',
    exportName: 'cancelUnpaid',
    todo: 'TODO(skip): cancelUnpaid must refuse paid or uncertain money and must not erase a payment',
    judge: judgeCancelRefusesPaid,
  },
  {
    id: 'payment_link_returned_not_sent',
    exportName: 'sendPaymentLink',
    todo: 'TODO(skip): sendPaymentLink must return a test-mode URL and must not send WhatsApp, SMS, or email',
    judge: judgeLinkNotSent,
  },
  {
    id: 'scoped_notes',
    exportName: 'writeNote',
    todo: 'TODO(skip): writeNote must write a v3-scoped note and must not replace tenant_house_notes',
    judge: judgeScopedNotes,
  },
  {
    id: 'timeout_unknown',
    exportName: 'recoverOperation',
    todo: 'TODO(skip): a timeout is unknown, not success and not proof of no write; read back before retry',
    judge: judgeTimeoutUnknown,
  },
];

const SECTION3_TOOLS = [
  'checkAvailability',
  'findRooms',
  'getPricingCatalog',
  'quote',
  'holdBeds',
  'book',
  'releaseHold',
  'getBooking',
  'getPaymentStatus',
  'sendPaymentLink',
  'cancelUnpaid',
  'readNotes',
  'writeNote',
  'saveTransferRequest',
  'handoffToHuman',
];

const TABLES = [
  'beds',
  'rooms',
  'pricing',
  'catalog',
  'holds',
  'bookings',
  'payments',
  'links',
  'notes',
  'transfers',
  'handoffs',
  'sends',
  'operations',
];

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8'));
}

function uncoveredToolNames() {
  return SECTION3_TOOLS.filter((name) => !HANDLER_CONTRACTS.some((contract) => contract.exportName === name));
}

function assertRealGuestDialogue(script) {
  const turns = script.turns || [];
  assert.equal(turns.length > 0, true, (script.id || 'script') + ' has no turns');
  for (const turn of turns) {
    const label = (script.id || 'script') + ' ' + (turn.name || 'turn');
    assert.equal(typeof turn.guest, 'string', label + ' is missing guest dialogue');
    assert.equal(turn.guest.trim().length >= 8, true, label + ' guest dialogue is empty or not real');
    assert.equal(/[A-Za-z]/.test(turn.guest), true, label + ' guest dialogue has no words');
  }
}

function assertRefusalAcceptance(script) {
  const interest = script.turns.find((turn) => turn.name === 'later_interest');
  const accept = script.turns.find((turn) => turn.name === 'accept_fresh_quote');
  assert.equal(!!interest && !!accept, true, 'missing interest or fresh-quote acceptance');
  assert.equal(interest.consent, false, 'earlier interest was treated as consent');
  assert.equal(accept.consent, true, 'fresh quote has no explicit acceptance');
  assert.equal(interest.guest, REFUSAL_INTEREST_GUEST);
  assert.equal(accept.guest, REFUSAL_ACCEPT_GUEST);
  assert.notEqual(interest.guest, accept.guest, 'acceptance reused the interest sentence');
  assert.equal(script.turns.filter((turn) => turn.consent === true).length, 1);
  assert.equal(script.turns.indexOf(interest) < script.turns.indexOf(accept), true);
  assert.equal(accept.fresh_quote.shown_before_this_turn, true);
  assert.equal(accept.must_not.includes('book the refused split'), true);
  assert.equal(accept.must_not.includes('treat the earlier interest sentence as consent'), true);
}

function assertLifecycleBinding(script) {
  const setup = script.turns.find((turn) => turn.name === 'setup_booking');
  const read = script.turns.find((turn) => turn.name === 'read');
  const complete = script.turns.find((turn) => turn.name === 'sandbox_payment_complete');
  const timeout = script.turns.find((turn) => turn.name === 'timeout_retry');
  assert.equal(!!setup, true, 'missing initial booking setup');
  assert.equal(setup.guest, LIFECYCLE_SETUP_GUEST);
  assert.equal(setup.record_binding.alias, 'Casey');
  assert.equal(setup.record_binding.bind_field, 'selected_booking_id');
  assert.equal(setup.record_binding.must_persist_before, 'read');
  assert.equal(script.turns.indexOf(setup) < script.turns.indexOf(read), true, 'read is not bound to a prior booking record');
  assert.equal(!!complete, true, 'missing sandbox payment completion');
  assert.equal(complete.guest, LIFECYCLE_COMPLETE_GUEST);
  const stepText = JSON.stringify(complete.steps);
  assert.equal(/sandbox checkout/.test(stepText), true, 'sandbox completion steps are missing');
  assert.equal(/getPaymentStatus/.test(stepText), true, 'sandbox completion does not call getPaymentStatus');
  assert.equal(/no live card/.test(stepText), true, 'sandbox completion does not forbid a live card');
  assert.equal(timeout.operation, 'getPaymentStatus');
  assert.equal(timeout.fault_point.call, 'getPaymentStatus');
  assert.equal(timeout.fault_point.after, 'sandbox checkout completion');
  assert.equal(timeout.fault_point.before, 'paid confirmation');
  assert.equal(timeout.fault_point.record, 'selected_booking_id');
  assert.equal(timeout.guest, LIFECYCLE_TIMEOUT_GUEST);
}

function assertRemovingDialogueFails() {
  for (const name of REQUIRED_SCRIPTS) {
    const stripped = JSON.parse(JSON.stringify(readJson(name)));
    for (const turn of stripped.turns) delete turn.guest;
    assert.throws(
      () => assertRealGuestDialogue(stripped),
      name + ' validated after real guest dialogue was removed',
    );
  }
  const refusal = JSON.parse(JSON.stringify(readJson('guest-04-refusal.json')));
  const accept = refusal.turns.find((turn) => turn.name === 'accept_fresh_quote');
  delete accept.guest;
  assert.throws(() => {
    assertRealGuestDialogue(refusal);
    assertRefusalAcceptance(refusal);
  }, 'fresh-quote acceptance validated after its guest turn was removed');
  const lifecycle = JSON.parse(JSON.stringify(readJson('guest-05-lifecycle.json')));
  const setup = lifecycle.turns.find((turn) => turn.name === 'setup_booking');
  delete setup.guest;
  assert.throws(() => {
    assertRealGuestDialogue(lifecycle);
    assertLifecycleBinding(lifecycle);
  }, 'booking setup validated after its guest turn was removed');
}

function assertFixtures() {
  const manifest = readJson('manifest.json');
  const scorecard = readJson('scorecard.json');
  assert.deepEqual(manifest.scripts, REQUIRED_SCRIPTS);
  assert.equal(manifest.date_rule.guest_1_frozen, true);
  assert.equal(manifest.date_rule.guests_2_to_5_stock_pricing_confirmed, false);
  assert.equal(manifest.phone_rule.collision_checked, false);
  assert.equal(scorecard.paired_runs, 3);
  assert.deepEqual(scorecard.alternating_order, [
    ['v3', 'classic'],
    ['classic', 'v3'],
    ['v3', 'classic'],
  ]);
  assert.equal(scorecard.safety_floor.no_refused_split_booked, true);
  assert.equal(scorecard.safety_floor.no_real_sends, true);
  assert.equal(scorecard.safety_floor.no_paid_cancellation_by_luna, true);
  assert.equal(scorecard.safety_floor.offset_by_nicer_prose, false);
  assert.equal(scorecard.beats_classic.if_both_complete_with_no_clear_experience_win, 'parity');
  assert.equal(scorecard.beats_classic.do_not_call_parity_beats, true);

  const phone = /^\+346999\d{5}$/;
  const couple = readJson('guest-01-couple.json');
  const room10 = readJson('guest-01-room10-only.json');
  assert.equal(couple.dates.check_in, '2027-11-05');
  assert.equal(couple.dates.check_out, '2027-11-15');
  assert.equal(couple.together, true);
  assert.equal(couple.party_size, 2);
  assert.equal(room10.dates.check_in, '2027-11-05');
  assert.equal(room10.dates.check_out, '2027-11-15');
  assert.match(JSON.stringify(room10), /Room 10/);
  assert.equal(room10.stock_fixture.room_7.includes('not suitable'), true);

  for (const name of REQUIRED_SCRIPTS) {
    const script = readJson(name);
    assert.equal(phone.test(script.phone), true, name + ' phone is not an expanded +34 699 9xx number');
    assert.equal(script.collision_checked, false, name);
    assert.equal(script.synthetic, true, name);
    assert.equal(String(script.dates.check_in).startsWith('2027-'), true, name);
    assert.equal(String(script.dates.check_out).startsWith('2027-'), true, name);
    assert.equal(script.dates.stock_pricing_confirmed, false, name);
    assertRealGuestDialogue(script);
  }

  const refusal = readJson('guest-04-refusal.json');
  assert.equal(refusal.stock_fixture.same_room_pair, 'none');
  const refusalText = JSON.stringify(refusal);
  assert.equal(refusalText.includes('payment link'), true);
  assert.equal(refusalText.includes('No. We will not split.'), true);
  assert.equal(refusal.fail.includes('split booking'), true);
  assertRefusalAcceptance(refusal);
  const lifecycle = readJson('guest-05-lifecycle.json');
  assert.equal(lifecycle.payment.real_charge, false);
  assert.equal(lifecycle.turns.some((turn) => turn.name === 'timeout_retry'), true);
  assertLifecycleBinding(lifecycle);
  const solo = readJson('guest-02-solo-package.json');
  assert.equal(solo.guests[0].gender_stated, false);
  assert.equal(solo.quote_style.owner_doc_edited_here, false);
  assert.equal(uncoveredToolNames().length, 10);
  assert.equal(uncoveredToolNames().includes('book'), true);
  assert.equal(uncoveredToolNames().includes('getBooking'), true);
  assert.equal(uncoveredToolNames().includes('getPaymentStatus'), true);
  assertRemovingDialogueFails();
}

function failed(reason) {
  return { pass: false, reason };
}

function rejectPromise(result) {
  if (result && (typeof result === 'object' || typeof result === 'function') && typeof result.then === 'function') {
    return failed('async result was judged as a Promise');
  }
  return null;
}

function unconnected() {
  return { pass: false, pending: true, reason: 'no independent DB observation' };
}

function tableRows(observed, table) {
  return (observed && observed.tables && observed.tables[table]) || [];
}

function sawRead(observed, table) {
  return (observed.calls || []).some((call) => {
    if (call.op === 'read' && call.table === table) return true;
    if (call.op === 'query' && new RegExp('\\bfrom\\s+' + table + '\\b', 'i').test(call.sql || '')) return true;
    return false;
  });
}

function sawWrite(observed, table) {
  return (observed.calls || []).some((call) => {
    if ((call.op === 'write' || call.op === 'update') && call.table === table) return true;
    if (call.op === 'query' && new RegExp('\\b(?:insert\\s+into|update)\\s+' + table + '\\b', 'i').test(call.sql || '')) return true;
    return false;
  });
}

function judgeHoldAllOrNone(result, observed) {
  const promise = rejectPromise(result);
  if (promise) return promise;
  if (!result || (result.ok === true && !result.assignments)) return failed('bare ok is not an all-or-none hold');
  if (result.partial === true || (Array.isArray(result.assignments) && result.assignments.length === 1 && result.requestedCount > 1)) {
    return failed('partial hold');
  }
  if (result.held === true && !result.holdId) return failed('held without a persisted hold id');
  if (result.held === false && result.holdId) return failed('refusal still returned a hold id');
  const shapePass = (result.held === true && Array.isArray(result.assignments) && result.assignments.length === result.requestedCount)
    || (result.held === false && !result.holdId && result.unknown !== true);
  if (!shapePass) return failed('hold result did not prove all-or-none');
  if (!observed || !observed.touched) return unconnected();
  if (!sawRead(observed, 'beds')) return failed('hold did not read bed stock');
  const holds = tableRows(observed, 'holds');
  if (result.held === false) {
    if (holds.length !== 0) return failed('refusal still persisted a hold');
    return { pass: true };
  }
  const requested = result.requestedBeds || [];
  const heldBeds = holds.map((row) => row.bedId || row.bed_id);
  if (heldBeds.length !== requested.length) return failed('observed hold count does not match the request');
  if (requested.some((bed) => !heldBeds.includes(bed))) return failed('observed holds missed a requested bed');
  if (!holds.every((row) => row.holdId === result.holdId)) return failed('observed hold id does not match the return');
  return { pass: true };
}

function judgeNoSubstitution(result, observed) {
  const promise = rejectPromise(result);
  if (promise) return promise;
  if (!result || (result.ok === true && !Array.isArray(result.assignments))) return failed('bare ok can hide a substituted bed');
  if (result.substituted === true) return failed('substituted flag');
  const requested = result.requestedBeds || [];
  const assigned = (result.assignments || []).map((row) => row.bedId || row.bed_id);
  if (!requested.length) return failed('no requested beds to compare');
  if (assigned.some((bed) => !requested.includes(bed))) return failed('assigned a bed that was not requested');
  if (result.held === true && assigned.length !== requested.length) return failed('held a different set than requested');
  if (!observed || !observed.touched) return unconnected();
  if (!sawRead(observed, 'beds')) return failed('substitution check did not read beds');
  const heldBeds = tableRows(observed, 'holds').map((row) => row.bedId || row.bed_id);
  if (heldBeds.some((bed) => !requested.includes(bed))) return failed('observed a bed that was not requested');
  return { pass: true };
}

function judgeStaffMoney(result, observed) {
  const promise = rejectPromise(result);
  if (promise) return promise;
  if (!result || (result.ok === true && result.totalCents == null)) return failed('bare ok is not Staff money');
  if (result.source !== 'staff_pricing') return failed('money source is not staff_pricing');
  if (result.acceptedModelAmount === true) return failed('model amount was accepted');
  if (!Number.isInteger(result.totalCents) || !Number.isInteger(result.depositCents)) return failed('cents are not integers');
  if (!observed || !observed.touched) return unconnected();
  if (!sawRead(observed, 'pricing')) return failed('quote did not read Staff pricing');
  const staff = tableRows(observed, 'pricing')[0];
  if (!staff || result.totalCents !== staff.totalCents || result.depositCents !== staff.depositCents) {
    return failed('returned cents do not match observed Staff pricing');
  }
  if (result.totalCents === 1) return failed('model amount was accepted');
  return { pass: true };
}

function judgeCancelRefusesPaid(result, observed) {
  const promise = rejectPromise(result);
  if (promise) return promise;
  if (!result) return failed('missing cancel result');
  if (result.cancelled === true && result.paid === true) return failed('paid booking was cancelled');
  if (result.paymentErased === true) return failed('payment evidence was erased');
  if (!(result.refused === true && result.cancelled !== true)) return failed('paid cancel was not an explicit refusal');
  if (!observed || !observed.touched) return unconnected();
  if (!sawRead(observed, 'payments') && !sawRead(observed, 'bookings')) return failed('cancel did not read payment state');
  const payments = tableRows(observed, 'payments');
  if (!payments.length || payments.some((row) => row.status !== 'paid')) return failed('observed payment was erased or rewritten');
  const bookings = tableRows(observed, 'bookings');
  if (bookings.some((row) => row.cancelled === true)) return failed('observed booking was cancelled');
  return { pass: true };
}

function judgeLinkNotSent(result, observed) {
  const promise = rejectPromise(result);
  if (promise) return promise;
  if (!result || (result.ok === true && !result.url)) return failed('bare ok is not a returned link');
  if (typeof result.url !== 'string' || !result.url) return failed('missing url');
  if (result.sent === true) return failed('link was sent');
  if (result.whatsapp || result.sms || result.email) return failed('a transport was used');
  if (result.mode !== 'test') return failed('link mode is not test');
  if (!observed || !observed.touched) return unconnected();
  if (sawWrite(observed, 'sends') || tableRows(observed, 'sends').length) return failed('a send row was written');
  const links = tableRows(observed, 'links');
  if (!sawWrite(observed, 'links') || !links.length) return failed('no payment link row was stored');
  if (!links.some((row) => row.url === result.url && row.mode === 'test')) return failed('stored link does not match the return');
  return { pass: true };
}

function judgeScopedNotes(result, observed) {
  const promise = rejectPromise(result);
  if (promise) return promise;
  if (!result || (result.ok === true && !result.noteId)) return failed('bare ok is not a scoped note');
  if (result.replacedSharedHouseNotes === true) return failed('shared General Notes were replaced');
  if (result.target === 'tenant_house_notes') return failed('write targeted the shared house-notes document');
  if (result.scope !== 'luna-v3') return failed('note scope is not luna-v3');
  if (!result.noteId) return failed('missing note id');
  if (!observed || !observed.touched) return unconnected();
  const notes = tableRows(observed, 'notes');
  const shared = notes.find((row) => row.target === 'tenant_house_notes');
  if (!shared || shared.text !== 'keep me') return failed('shared house notes were replaced');
  const saved = notes.find((row) => row.id === result.noteId);
  if (!sawWrite(observed, 'notes') || !saved || saved.scope !== 'luna-v3') return failed('observed note is not the scoped v3 note');
  return { pass: true };
}

function judgeTimeoutUnknown(result, observed) {
  const promise = rejectPromise(result);
  if (promise) return promise;
  if (!result) return failed('missing timeout result');
  if (result.ok === true) return failed('timeout was treated as success');
  if (result.wrote === false && result.status !== 'unknown') return failed('timeout was treated as proof of no write');
  if (result.status !== 'unknown') return failed('timeout status is not unknown');
  if (result.readBack !== true) return failed('no readback before retry');
  if (!observed || !observed.touched) return unconnected();
  const first = (observed.calls || [])[0];
  const firstIsRead = first && (first.op === 'read' || (first.op === 'query' && /^\s*select\b/i.test(first.sql || '')));
  if (!firstIsRead) return failed('retry wrote before readback');
  const ops = tableRows(observed, 'operations');
  if (ops.length !== 1 || ops[0].status !== 'unknown') return failed('timeout was rewritten or duplicated');
  if (sawWrite(observed, 'operations')) return failed('timeout retry wrote a second operation');
  return { pass: true };
}

function judgeTool(name, result, observed) {
  const promise = rejectPromise(result);
  if (promise) return promise;
  if (!observed || !observed.touched) return unconnected();
  if (name === 'checkAvailability') {
    if (!sawRead(observed, 'beds')) return failed('availability did not read beds');
    const available = tableRows(observed, 'beds').filter((row) => row.available === true);
    if (!result || result.availableCount !== available.length) return failed('availability did not match observed beds');
    return { pass: true };
  }
  if (name === 'findRooms') {
    if (!sawRead(observed, 'rooms')) return failed('findRooms did not read rooms');
    const ids = tableRows(observed, 'rooms').map((row) => row.id);
    if (!result || !Array.isArray(result.roomIds) || ids.some((id) => !result.roomIds.includes(id))) {
      return failed('findRooms did not return observed rooms');
    }
    return { pass: true };
  }
  if (name === 'getPricingCatalog') {
    if (!sawRead(observed, 'catalog')) return failed('catalog was not read');
    const item = tableRows(observed, 'catalog')[0];
    if (!result || !item || result.totalCents !== item.totalCents) return failed('catalog cents do not match observed Staff catalog');
    return { pass: true };
  }
  if (name === 'book') {
    if (!sawRead(observed, 'holds') || !sawWrite(observed, 'bookings')) return failed('book did not read the hold and persist a booking');
    const booking = tableRows(observed, 'bookings').find((row) => row.holdId === 'hold-1');
    if (!result || !booking || result.bookingId !== booking.id) return failed('returned booking id does not match observed booking');
    return { pass: true };
  }
  if (name === 'releaseHold') {
    if (!sawRead(observed, 'holds')) return failed('releaseHold did not read the hold');
    const hold = tableRows(observed, 'holds').find((row) => row.id === 'hold-1');
    if (!hold || hold.status !== 'released') return failed('observed hold was not released');
    if (tableRows(observed, 'bookings').length) return failed('releaseHold created a booking');
    return { pass: true };
  }
  if (name === 'getBooking') {
    if (!sawRead(observed, 'bookings')) return failed('getBooking did not read bookings');
    const bound = tableRows(observed, 'bookings').find((row) => row.id === 'b-bound');
    const decoy = tableRows(observed, 'bookings').find((row) => row.id === 'phone-first');
    if (!result || !bound || result.bookingId !== bound.id || result.guest !== bound.guest) {
      return failed('getBooking did not return the bound record');
    }
    if (decoy && result.guest === decoy.guest) return failed('getBooking returned the phone-first booking');
    return { pass: true };
  }
  if (name === 'getPaymentStatus') {
    if (!sawRead(observed, 'payments')) return failed('getPaymentStatus did not read payments');
    const row = tableRows(observed, 'payments').find((item) => item.bookingId === 'b-bound');
    if (!result || !row || result.status !== row.status || result.paymentId !== row.id) {
      return failed('getPaymentStatus did not match the observed payment');
    }
    return { pass: true };
  }
  if (name === 'readNotes') {
    if (!sawRead(observed, 'notes')) return failed('readNotes did not read notes');
    const scoped = tableRows(observed, 'notes').find((row) => row.scope === 'luna-v3');
    if (!result || !scoped || result.noteId !== scoped.id || result.target === 'tenant_house_notes') {
      return failed('readNotes returned the shared house notes');
    }
    return { pass: true };
  }
  if (name === 'saveTransferRequest') {
    if (!sawWrite(observed, 'transfers')) return failed('transfer was not saved');
    const row = tableRows(observed, 'transfers').find((item) => item.airport === 'BIO' && item.time === '14:00');
    if (!result || !row || result.transferId !== row.id) return failed('observed transfer does not match the return');
    if (tableRows(observed, 'sends').length) return failed('transfer saved a send');
    return { pass: true };
  }
  if (name === 'handoffToHuman') {
    if (!sawWrite(observed, 'handoffs')) return failed('handoff was not saved');
    const row = tableRows(observed, 'handoffs')[0];
    if (!result || !row || result.handoffId !== row.id || result.sent === true) return failed('observed handoff does not match the return');
    if (tableRows(observed, 'sends').length) return failed('handoff sent a message');
    return { pass: true };
  }
  return failed('no independent observation for ' + name);
}

function stubProbe() {
  const cases = [
    ['hold', judgeHoldAllOrNone, { ok: true }],
    ['substitution', judgeNoSubstitution, { ok: true }],
    ['money', judgeStaffMoney, { ok: true, totalCents: 100, source: 'model', acceptedModelAmount: true }],
    ['cancel', judgeCancelRefusesPaid, { cancelled: true, paid: true }],
    ['link', judgeLinkNotSent, { ok: true, url: 'https://pay.test/x', sent: true, mode: 'test' }],
    ['notes', judgeScopedNotes, { ok: true, noteId: 'n1', scope: 'luna-v3', replacedSharedHouseNotes: true }],
    ['timeout', judgeTimeoutUnknown, { ok: true, status: 'success' }],
  ];
  for (const [name, judge, sample] of cases) {
    const verdict = judge(sample);
    assert.equal(verdict.pass, false, name + ' stub was accepted: ' + JSON.stringify(verdict));
  }
  const shaped = [
    ['hold-shaped', judgeHoldAllOrNone, { held: true, holdId: 'h', assignments: [{ bedId: 'bed-a' }, { bedId: 'bed-b' }], requestedCount: 2, requestedBeds: ['bed-a', 'bed-b'] }],
    ['hold-refused-shaped', judgeHoldAllOrNone, { held: false }],
    ['substitution-shaped', judgeNoSubstitution, { requestedBeds: ['bed-a'], assignments: [], held: false }],
    ['money-shaped', judgeStaffMoney, { source: 'staff_pricing', totalCents: 100, depositCents: 50, acceptedModelAmount: false }],
    ['cancel-shaped', judgeCancelRefusesPaid, { refused: true, cancelled: false }],
    ['link-shaped', judgeLinkNotSent, { url: 'https://pay.test/x', sent: false, mode: 'test' }],
    ['notes-shaped', judgeScopedNotes, { noteId: 'n1', scope: 'luna-v3' }],
    ['timeout-shaped', judgeTimeoutUnknown, { status: 'unknown', readBack: true }],
  ];
  for (const [name, judge, sample] of shaped) {
    const verdict = judge(sample);
    assert.equal(verdict.pass, false, name + ' return shape passed without a DB observation');
    assert.equal(verdict.pending, true, name + ' unconnected shape was not pending');
  }
  const promised = judgeHoldAllOrNone(Promise.resolve({ held: false }));
  assert.equal(promised.pass, false, 'a Promise was accepted as a hold result');
  assert.equal(promised.reason, 'async result was judged as a Promise');
}

function filterRows(rows, filter) {
  if (!filter) return rows.slice();
  return rows.filter((row) => Object.keys(filter).every((key) => row[key] === filter[key]));
}

function applySql(tables, sql, params) {
  const text = sql.replace(/\s+/g, ' ').trim();
  let match = /^select \* from (\w+) where id = \$1$/i.exec(text);
  if (match) {
    return { rows: JSON.parse(JSON.stringify((tables[match[1]] || []).filter((row) => row.id === params[0]))) };
  }
  match = /^select \* from (\w+)$/i.exec(text);
  if (match) return { rows: JSON.parse(JSON.stringify(tables[match[1]] || [])) };
  match = /^insert into (\w+) \(json\) values \(\$1\)$/i.exec(text);
  if (match) {
    const table = match[1];
    const stored = JSON.parse(JSON.stringify(params[0] || {}));
    if (!tables[table]) tables[table] = [];
    if (!stored.id) stored.id = table + '-' + (tables[table].length + 1);
    tables[table].push(stored);
    return { rows: [JSON.parse(JSON.stringify(stored))] };
  }
  match = /^update (\w+) set status = \$1 where id = \$2$/i.exec(text);
  if (match) {
    const row = (tables[match[1]] || []).find((item) => item.id === params[1]);
    if (row) row.status = params[0];
    return { rows: row ? [JSON.parse(JSON.stringify(row))] : [] };
  }
  return { rows: [] };
}

function createObservationDb(seed) {
  const tables = {};
  for (const name of TABLES) tables[name] = [];
  const source = seed || {};
  for (const name of Object.keys(source)) {
    tables[name] = JSON.parse(JSON.stringify(source[name]));
  }
  const calls = [];
  function note(op, detail) {
    calls.push(Object.assign({ op }, detail));
  }
  const pg = {
    async query(sql, params) {
      const text = String(sql);
      const bound = Array.isArray(params) ? params.slice() : [];
      note('query', { sql: text, params: bound });
      return applySql(tables, text, bound);
    },
    async read(table, filter) {
      note('read', { table, filter: filter || null });
      return filterRows(tables[table] || [], filter).map((row) => JSON.parse(JSON.stringify(row)));
    },
    async write(table, row) {
      const stored = JSON.parse(JSON.stringify(row || {}));
      if (!tables[table]) tables[table] = [];
      if (!stored.id) stored.id = table + '-' + (tables[table].length + 1);
      note('write', { table, id: stored.id });
      tables[table].push(stored);
      return JSON.parse(JSON.stringify(stored));
    },
    async update(table, id, patch) {
      note('update', { table, id });
      const rows = tables[table] || [];
      const row = rows.find((item) => item.id === id);
      if (!row) return null;
      Object.assign(row, JSON.parse(JSON.stringify(patch || {})));
      return JSON.parse(JSON.stringify(row));
    },
  };
  return {
    pg,
    snapshot() {
      return {
        touched: calls.length > 0,
        calls: calls.map((call) => Object.assign({}, call)),
        tables: JSON.parse(JSON.stringify(tables)),
      };
    },
  };
}

function contractFixture(id) {
  if (id === 'hold_all_or_none') return { requestedBeds: ['bed-a', 'bed-b'], secondUnavailable: true };
  if (id === 'no_bed_substitution') return { requestedBeds: ['bed-a'], unavailable: ['bed-a'] };
  if (id === 'staff_computed_money') return { modelTotalCents: 1 };
  if (id === 'cancel_unpaid_refuses_paid') return { paid: true };
  if (id === 'payment_link_returned_not_sent') return { choice: 'deposit' };
  if (id === 'scoped_notes') return { text: 'v3 test note' };
  return { timedOut: true };
}

function seedFor(id) {
  if (id === 'hold_all_or_none') {
    return {
      beds: [{ id: 'bed-a', available: true }, { id: 'bed-b', available: false }],
      holds: [],
    };
  }
  if (id === 'no_bed_substitution') {
    return {
      beds: [{ id: 'bed-a', available: false }, { id: 'bed-other', available: true }],
      holds: [],
    };
  }
  if (id === 'staff_computed_money') {
    return { pricing: [{ id: 'staff', totalCents: 424242, depositCents: 101010, source: 'staff_pricing' }] };
  }
  if (id === 'cancel_unpaid_refuses_paid') {
    return {
      bookings: [{ id: 'b-paid', paid: true, cancelled: false }],
      payments: [{ id: 'p1', bookingId: 'b-paid', status: 'paid', amountCents: 5000 }],
    };
  }
  if (id === 'payment_link_returned_not_sent') {
    return { bookings: [{ id: 'b1', paid: false }], sends: [], links: [] };
  }
  if (id === 'scoped_notes') {
    return { notes: [{ id: 'shared', target: 'tenant_house_notes', scope: 'house', text: 'keep me' }] };
  }
  return { operations: [{ id: 'op1', name: 'getPaymentStatus', status: 'unknown' }] };
}

function toolFixture(name) {
  if (name === 'book' || name === 'releaseHold') return { holdId: 'hold-1' };
  if (name === 'getBooking') return { bookingId: 'b-bound' };
  if (name === 'getPaymentStatus') return { bookingId: 'b-bound' };
  if (name === 'saveTransferRequest') return { airport: 'BIO', time: '14:00' };
  if (name === 'handoffToHuman') return { reason: 'paid-cancel' };
  return {};
}

function seedForTool(name) {
  if (name === 'checkAvailability') {
    return {
      beds: [
        { id: 'bed-1', available: true },
        { id: 'bed-2', available: true },
        { id: 'bed-3', available: true },
        { id: 'bed-4', available: false },
      ],
    };
  }
  if (name === 'findRooms') return { rooms: [{ id: 'room-7' }, { id: 'room-10' }] };
  if (name === 'getPricingCatalog') return { catalog: [{ id: 'surf', totalCents: 333333 }] };
  if (name === 'book') return { holds: [{ id: 'hold-1', beds: ['bed-a'], status: 'active' }], bookings: [] };
  if (name === 'releaseHold') return { holds: [{ id: 'hold-1', status: 'active' }], bookings: [] };
  if (name === 'getBooking') {
    return {
      bookings: [
        { id: 'phone-first', guest: 'Wrong person' },
        { id: 'b-bound', guest: 'Casey-sentinel', bound: true },
      ],
    };
  }
  if (name === 'getPaymentStatus') {
    return {
      payments: [
        { id: 'pay-other', bookingId: 'other', status: 'unpaid' },
        { id: 'pay-1', bookingId: 'b-bound', status: 'sandbox_paid' },
      ],
    };
  }
  if (name === 'readNotes') {
    return {
      notes: [
        { id: 'shared', target: 'tenant_house_notes', scope: 'house', text: 'keep' },
        { id: 'v3-note', target: 'luna-v3-notes', scope: 'luna-v3', text: 'scoped' },
      ],
    };
  }
  if (name === 'saveTransferRequest') return { transfers: [], sends: [] };
  if (name === 'handoffToHuman') return { handoffs: [], sends: [] };
  return {};
}

function toolTodo(name, present) {
  if (!present) {
    return 'TODO(skip): export ' + name + ' from scripts/lib/model-led-luna/index.js; do not compose a guest reply';
  }
  return 'TODO(skip): ' + name + ' must be awaited and must read or write Staff state; existence is not proof';
}

async function evaluateExport(id, todo, fn, input, seed, judge) {
  if (typeof fn !== 'function') return { id, status: 'pending', todo };
  const harness = createObservationDb(seed);
  let result;
  try {
    result = await fn(harness.pg, input);
  } catch (err) {
    return { id, status: 'fail', todo, reason: err && err.message ? err.message : String(err) };
  }
  if (result && typeof result.then === 'function') {
    return { id, status: 'fail', todo, reason: 'async result was still a Promise after await' };
  }
  const observed = harness.snapshot();
  if (!observed.touched) {
    return { id, status: 'pending', todo, reason: 'handler exists but touched no DB' };
  }
  const verdict = judge(result, observed);
  if (verdict.pending) return { id, status: 'pending', todo, reason: verdict.reason || 'unconnected' };
  return { id, status: verdict.pass ? 'pass' : 'fail', todo, reason: verdict.reason || '' };
}

function loadHandlers() {
  const override = process.env.LUNA_V3_HANDLER_INDEX;
  const indexPath = override ? path.resolve(override) : handlerIndex;
  if (!fs.existsSync(indexPath)) return null;
  return require(indexPath);
}

async function runHandlerContracts(api) {
  const rows = [];
  for (const contract of HANDLER_CONTRACTS) {
    const fn = api && api[contract.exportName];
    rows.push(await evaluateExport(
      contract.id,
      contract.todo,
      fn,
      contractFixture(contract.id),
      seedFor(contract.id),
      contract.judge,
    ));
  }
  // Always enforce the full uncovered tool list. An index must not drop these.
  for (const name of uncoveredToolNames()) {
    const fn = api && api[name];
    rows.push(await evaluateExport(
      'tool_' + name,
      toolTodo(name, typeof fn === 'function'),
      fn,
      toolFixture(name),
      seedForTool(name),
      (result, observed) => judgeTool(name, result, observed),
    ));
  }
  return rows;
}

function fakeShape(name) {
  if (name === 'holdBeds') {
    return {
      held: true,
      holdId: 'h',
      assignments: [{ bedId: 'bed-a' }, { bedId: 'bed-b' }],
      requestedCount: 2,
      requestedBeds: ['bed-a', 'bed-b'],
    };
  }
  if (name === 'quote') {
    return { ok: true, source: 'staff_pricing', totalCents: 100, depositCents: 50, acceptedModelAmount: false };
  }
  if (name === 'cancelUnpaid') return { refused: true, cancelled: false, paid: true };
  if (name === 'sendPaymentLink') return { ok: true, url: 'https://pay.test/x', sent: false, mode: 'test' };
  if (name === 'writeNote') return { ok: true, noteId: 'n1', scope: 'luna-v3' };
  if (name === 'book') return { ok: true, bookingId: 'b1' };
  if (name === 'getBooking') return { ok: true, bookingId: 'b-bound', guest: 'Casey-sentinel' };
  if (name === 'getPaymentStatus') return { ok: true, status: 'sandbox_paid', paymentId: 'pay-1' };
  if (name === 'checkAvailability') return { ok: true, availableCount: 3 };
  if (name === 'findRooms') return { ok: true, roomIds: ['room-7', 'room-10'] };
  if (name === 'getPricingCatalog') return { ok: true, totalCents: 333333 };
  if (name === 'releaseHold') return { ok: true, holdId: 'hold-1', status: 'released' };
  if (name === 'readNotes') return { ok: true, noteId: 'v3-note', scope: 'luna-v3' };
  if (name === 'saveTransferRequest') return { ok: true, transferId: 't1' };
  if (name === 'handoffToHuman') return { ok: true, handoffId: 'h1', sent: false };
  return { ok: true };
}

async function assertFakeHandlersDoNotPass() {
  const fakes = {};
  const asyncFakes = {};
  for (const name of SECTION3_TOOLS) {
    fakes[name] = () => fakeShape(name);
    asyncFakes[name] = async () => fakeShape(name);
  }
  fakes.recoverOperation = () => ({ ok: false, status: 'unknown', readBack: true });
  asyncFakes.recoverOperation = async () => ({ ok: false, status: 'unknown', readBack: true });
  for (const api of [fakes, asyncFakes]) {
    const rows = await runHandlerContracts(api);
    assert.equal(rows.some((row) => row.status === 'pass'), false, 'fake handlers that touch no DB passed');
    const notPending = rows.filter((row) => row.status !== 'pending');
    assert.equal(notPending.length, 0, 'unconnected fake was not pending: ' + JSON.stringify(notPending));
    for (const name of ['book', 'getBooking', 'getPaymentStatus']) {
      assert.equal(rows.some((row) => row.id === 'tool_' + name), true, name + ' check vanished once an index existed');
    }
  }
  const partial = {
    quote() {
      return { ok: true, source: 'staff_pricing', totalCents: 1, depositCents: 1 };
    },
  };
  const partialRows = await runHandlerContracts(partial);
  assert.equal(partialRows.some((row) => row.id === 'tool_book' && row.status === 'pending'), true);
  assert.equal(partialRows.some((row) => row.id === 'tool_getBooking' && row.status === 'pending'), true);
  assert.equal(partialRows.some((row) => row.id === 'tool_getPaymentStatus' && row.status === 'pending'), true);
  assert.equal(partialRows.some((row) => row.status === 'pass'), false);
}

function connectedProbes() {
  return {
    async holdBeds(pg, input) {
      const beds = await pg.read('beds');
      const unavailable = new Set(beds.filter((row) => row.available === false).map((row) => row.id));
      const requested = input.requestedBeds || [];
      if (input.secondUnavailable || requested.some((id) => unavailable.has(id))) {
        return { held: false, substituted: false, requestedBeds: requested, assignments: [] };
      }
      const holdId = 'hold-all';
      for (const bedId of requested) await pg.write('holds', { holdId, bedId });
      return {
        held: true,
        holdId,
        requestedCount: requested.length,
        requestedBeds: requested,
        assignments: requested.map((bedId) => ({ bedId })),
      };
    },
    async quote(pg) {
      const rows = await pg.read('pricing');
      const staff = rows[0];
      return {
        ok: true,
        source: staff.source,
        totalCents: staff.totalCents,
        depositCents: staff.depositCents,
        acceptedModelAmount: false,
      };
    },
    async cancelUnpaid(pg, input) {
      const payments = await pg.read('payments');
      if (input.paid === true || payments.some((row) => row.status === 'paid')) {
        return { refused: true, cancelled: false, paid: true, paymentErased: false };
      }
      return { refused: false, cancelled: true, paid: false };
    },
    async sendPaymentLink(pg, input) {
      await pg.read('bookings');
      const stored = await pg.write('links', {
        url: 'https://pay.test/sandbox-deposit',
        mode: 'test',
        sent: false,
        choice: input.choice,
      });
      return { ok: true, url: stored.url, sent: false, mode: 'test' };
    },
    async writeNote(pg, input) {
      await pg.read('notes');
      const stored = await pg.write('notes', { scope: 'luna-v3', text: input.text, target: 'luna-v3-notes' });
      return { ok: true, noteId: stored.id, scope: 'luna-v3', replacedSharedHouseNotes: false };
    },
    async recoverOperation(pg) {
      const ops = await pg.read('operations');
      return { ok: false, status: ops[0].status, readBack: true, wrote: null };
    },
    async checkAvailability(pg) {
      const beds = await pg.read('beds');
      const available = beds.filter((row) => row.available === true);
      return { ok: true, availableCount: available.length, bedIds: available.map((row) => row.id) };
    },
    async findRooms(pg) {
      const rooms = await pg.read('rooms');
      return { ok: true, roomIds: rooms.map((row) => row.id) };
    },
    async getPricingCatalog(pg) {
      const rows = await pg.read('catalog');
      return { ok: true, totalCents: rows[0].totalCents, items: rows };
    },
    async book(pg, input) {
      const holds = await pg.read('holds', { id: input.holdId });
      const stored = await pg.write('bookings', { holdId: holds[0].id, beds: holds[0].beds, status: 'booked' });
      return { ok: true, bookingId: stored.id, holdId: holds[0].id };
    },
    async releaseHold(pg, input) {
      await pg.read('holds', { id: input.holdId });
      await pg.update('holds', input.holdId, { status: 'released' });
      return { ok: true, holdId: input.holdId, status: 'released' };
    },
    async getBooking(pg, input) {
      const rows = await pg.read('bookings', { id: input.bookingId });
      return { ok: true, bookingId: rows[0].id, guest: rows[0].guest };
    },
    async getPaymentStatus(pg, input) {
      const rows = await pg.read('payments');
      const row = rows.find((item) => item.bookingId === input.bookingId);
      return { ok: true, paymentId: row.id, status: row.status, bookingId: row.bookingId };
    },
    async readNotes(pg) {
      const rows = await pg.read('notes');
      const row = rows.find((item) => item.scope === 'luna-v3');
      return { ok: true, noteId: row.id, scope: row.scope, target: row.target };
    },
    async saveTransferRequest(pg, input) {
      const stored = await pg.write('transfers', { airport: input.airport, time: input.time });
      return { ok: true, transferId: stored.id };
    },
    async handoffToHuman(pg, input) {
      const stored = await pg.write('handoffs', { reason: input.reason || 'paid-cancel' });
      return { ok: true, handoffId: stored.id, sent: false };
    },
  };
}

async function assertConnectedHandlerCanPass() {
  const probes = connectedProbes();
  for (const contract of HANDLER_CONTRACTS) {
    const row = await evaluateExport(
      contract.id,
      contract.todo,
      probes[contract.exportName],
      contractFixture(contract.id),
      seedFor(contract.id),
      contract.judge,
    );
    assert.equal(row.status, 'pass', contract.id + ' connected probe did not pass: ' + row.reason);
  }
  for (const name of uncoveredToolNames()) {
    const row = await evaluateExport(
      'tool_' + name,
      'probe',
      probes[name],
      toolFixture(name),
      seedForTool(name),
      (result, observed) => judgeTool(name, result, observed),
    );
    assert.equal(row.status, 'pass', name + ' connected probe did not pass: ' + row.reason);
  }
}

async function assertQueryPathCanPass() {
  const queryQuote = async (pg) => {
    const res = await pg.query('select * from pricing');
    const staff = res.rows[0];
    return {
      ok: true,
      source: staff.source,
      totalCents: staff.totalCents,
      depositCents: staff.depositCents,
      acceptedModelAmount: false,
    };
  };
  const row = await evaluateExport(
    'staff_computed_money',
    'query',
    queryQuote,
    contractFixture('staff_computed_money'),
    seedFor('staff_computed_money'),
    judgeStaffMoney,
  );
  assert.equal(row.status, 'pass', 'query path did not pass: ' + row.reason);
}

async function main() {
  const structural = [];
  try {
    assertFixtures();
    stubProbe();
    await assertFakeHandlersDoNotPass();
    await assertConnectedHandlerCanPass();
    await assertQueryPathCanPass();
    structural.push('fixtures', 'stub_rejection', 'fake_handlers_not_pass', 'connected_observation', 'query_observation');
  } catch (err) {
    console.error('FAIL structural ' + err.message);
    process.exit(1);
  }
  const rows = await runHandlerContracts(loadHandlers());
  const pending = rows.filter((row) => row.status === 'pending');
  const failedRows = rows.filter((row) => row.status === 'fail');
  const passed = rows.filter((row) => row.status === 'pass');
  const required = HANDLER_CONTRACTS.length + uncoveredToolNames().length;
  console.log('structural ' + structural.join(',') + ' pass');
  for (const row of rows) {
    console.log(row.status.toUpperCase() + ' ' + row.id + (row.todo ? ' ' + row.todo : '') + (row.reason ? ' ' + row.reason : ''));
  }
  console.log('handler_pass ' + passed.length + ' handler_pending ' + pending.length + ' handler_fail ' + failedRows.length + ' required ' + required);
  if (failedRows.length) {
    console.error('FAIL handler contract');
    process.exit(1);
  }
  if (pending.length) {
    console.error('PENDING not PASS; handlers missing or unconnected');
    process.exit(2);
  }
  if (passed.length !== required) {
    console.error('FAIL contract count');
    process.exit(1);
  }
  console.log('PASS luna v3 contracts');
}

main().catch((err) => {
  console.error('FAIL ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
