'use strict';

// Luna v3 offline contracts. Handler tests stay pending until Skip's
// scripts/lib/model-led-luna/ exists AND an awaited call leaves state the
// verifier reads back itself. A missing handler is not a pass. A function
// that merely exists, or returns a success shape without touching the
// observation DB, is not a pass. Unsafe writes are fails. A second booking
// beside a valid returned row is a fail. Lifecycle coverage must keep paid
// cancellation after paid state, the unpaid-cancel prohibition, and ordered
// checkout steps. Holds, payment links, and timeout recovery stay pending
// where the real boundary is not observable here. Do not certify those from
// a refusal flag, a stored string, or an unrelated read.
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
const LIFECYCLE_REBIND_GUEST = 'Make a new booking and I will pay the test link.';
const COUPLE_OPEN_GUEST = 'Hi, there are two of us, Alex and Sam. We want to stay together, same room, from 5 November to 15 November 2027.';
const COUPLE_ACCEPT_GUEST = 'Yes, book that same-room option.';
const ROOM10_OPEN_GUEST = 'We still need to be together, same room, 5 to 15 November 2027.';
const ROOM10_ACCEPT_GUEST = 'Yes, Room 10.';
const SOLO_OPEN_GUEST = 'Hi, I\'m Alex. I want a package for one person, 4 June to 8 June 2027.';
const SOLO_SHUTTLE_GUEST = 'The first package, and yes I want the shuttle. I arrive at Bilbao airport at 14:00.';
const MIXED_OPEN_GUEST = 'We are three: Nora, Luis, and Kim. 2 July to 9 July 2027.';
const MIXED_PACKAGES_GUEST = 'Nora wants the surf package, Luis wants no package, and Kim wants the surf package. Kim has not said if a mixed dorm is okay.';
const MIXED_DORM_GUEST = 'Kim is fine in a mixed dorm.';

const TRUSTED_BOOK = {
  tenant_id: 'tenant-sentinel',
  session_id: 'session-sentinel',
  guest: 'Casey-sentinel',
  beds: ['bed-a'],
  totalCents: 515151,
  holdId: 'hold-1',
  bookingId: 'b-bound',
};
const FOREIGN_BOOK = {
  tenant_id: 'foreign-tenant',
  session_id: 'foreign-session',
  guest: 'wrong-person',
  beds: ['unrequested-bed'],
  totalCents: -1,
};
const SAFETY_PROBES = [
  'two v3 sessions competing for the same beds',
  'v3 versus the existing Staff write path competing for the same beds',
];
const SAFETY_MONEY = ['tool results', 'stored records', 'rendered quotes', 'test checkout'];

const HANDLER_CONTRACTS = [
  {
    id: 'hold_all_or_none',
    exportName: 'holdBeds',
    todo: 'TODO(skip): holdBeds must persist every requested bed or none, including a race with an ordinary Staff writer; unavailable stock must not be held; success and the race stay pending until that boundary exists',
    judge: judgeHoldAllOrNone,
  },
  {
    id: 'no_bed_substitution',
    exportName: 'holdBeds',
    todo: 'TODO(skip): holdBeds must not swap in a different bed or room when the requested one is unavailable; a refusal is not the success path; that path stays pending',
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
    todo: 'TODO(skip): sendPaymentLink must return a sandbox-provider test URL bound to the booking and amount, and must not send; a stored string or self-declared test mode is not that proof',
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
    todo: 'TODO(skip): a timeout is unknown, not success and not proof of no write; read back the trusted operation and selected booking before retry; retry uniqueness stays pending until that effect is observable',
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

function lifecycleStepIndex(script, name) {
  const hits = [];
  script.turns.forEach((turn, index) => {
    if (turn && turn.name === name) hits.push(index);
  });
  assert.equal(hits.length, 1, 'lifecycle step ' + name + ' is missing or duplicated');
  return hits[0];
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
  assert.deepEqual(complete.steps, [
    {
      name: 'return_test_url',
      action: 'Return a test-mode payment URL inside Crow\'s Nest. Do not send WhatsApp, SMS, or email.',
    },
    {
      name: 'complete_sandbox_checkout',
      action: 'Complete the sandbox checkout on that URL with no live card and no real charge.',
    },
    {
      name: 'confirm_from_staff',
      action: 'Call getPaymentStatus for the bound booking and confirm only when Staff says paid.',
    },
  ], 'checkout steps are missing, duplicated, or out of order');
  assert.equal(timeout.operation, 'getPaymentStatus');
  assert.equal(timeout.fault_point.call, 'getPaymentStatus');
  assert.equal(timeout.fault_point.after, 'sandbox checkout completion');
  assert.equal(timeout.fault_point.before, 'paid confirmation');
  assert.equal(timeout.fault_point.record, 'selected_booking_id');
  assert.equal(timeout.guest, LIFECYCLE_TIMEOUT_GUEST);
  const pay = script.turns.find((turn) => turn.name === 'sandbox_payment');
  const cancel = script.turns.find((turn) => turn.name === 'cancel_unpaid');
  assert.equal(!!pay, true, 'missing new-booking rebind');
  assert.equal(pay.guest, LIFECYCLE_REBIND_GUEST);
  assert.equal(!!pay.record_binding, true, 'missing rebind record');
  assert.equal(pay.record_binding.alias, 'Casey');
  assert.equal(pay.record_binding.bind_field, 'selected_booking_id');
  assert.notEqual(pay.record_binding.bind_field, 'phone_first_booking_id');
  assert.equal(pay.record_binding.replaces, 'the cancelled unpaid booking');
  assert.equal(pay.record_binding.must_persist_before, 'sandbox_payment_complete');
  assert.equal(pay.must.includes('create a new unpaid booking through Staff after the cancel'), true, 'rebind does not create a new booking');
  assert.equal(pay.must.includes('rebind selected_booking_id to that new record before the sandbox checkout'), true, 'rebind instruction is missing');
  assert.equal(pay.must_not.includes('bind or charge the cancelled booking'), true, 'cancelled-booking prohibition is missing');
  assert.equal(pay.must_not.includes('use phone_first_booking_id'), true, 'phone-first rebind prohibition is missing');
  const payText = JSON.stringify(pay.must) + JSON.stringify(pay.record_binding);
  assert.equal(/use the cancelled booking/i.test(payText), false, 'rebind instructs use of the cancelled booking');
  assert.equal(/phone_first_booking_id/.test(payText), false, 'rebind names phone_first_booking_id');
  const order = [
    'setup_booking',
    'read',
    'cancel_unpaid',
    'sandbox_payment',
    'sandbox_payment_complete',
    'paid_cancel',
    'timeout_retry',
  ];
  const index = {};
  for (const name of order) index[name] = lifecycleStepIndex(script, name);
  for (let i = 1; i < order.length; i += 1) {
    assert.equal(
      index[order[i - 1]] < index[order[i]],
      true,
      order[i] + ' is not after ' + order[i - 1],
    );
  }
  const paid = script.turns[index.paid_cancel];
  assert.deepEqual(paid.must, [
    'handoff to a human',
    'make no refund promise',
    'not call cancel_unpaid on paid money',
  ], 'paid cancel lost its handoff and no-refund assertions');
  assert.deepEqual(paid.must_not, ['erase the payment'], 'paid cancel lost its no-erasure assertion');
  assert.deepEqual(cancel.must, [
    'cancel only after Staff shows the booking is unpaid',
  ], 'unpaid cancel lost its Staff-unpaid requirement');
  assert.deepEqual(cancel.must_not, [
    'cancel a paid or uncertain booking',
  ], 'unpaid cancel lost its paid prohibition');
  const cancelText = JSON.stringify(cancel.must) + JSON.stringify(cancel.must_not);
  assert.equal(/cancel even when staff reports paid money/i.test(cancelText), false, 'unpaid cancel instructs cancelling paid money');
  assert.equal(script.pass, 'unpaid cancel works, paid cancel goes to a human, timeout retry does not duplicate');
  assert.deepEqual(script.fail, [
    'paid booking cancelled by Luna',
    'real send',
    'duplicate charge or link',
    'timeout treated as success or as no write',
  ]);
}

function assertMust(turn, text, label) {
  assert.equal(Array.isArray(turn.must) && turn.must.includes(text), true, label + ' missing must: ' + text);
}

function assertFailIncludes(script, text) {
  assert.equal(Array.isArray(script.fail) && script.fail.includes(text), true, (script.id || 'script') + ' missing fail: ' + text);
}

function assertCoupleCoverage(script) {
  assert.equal(script.turns.length, 2, 'couple scenario was replaced');
  assert.equal(script.turns[0].guest, COUPLE_OPEN_GUEST);
  assert.equal(script.turns[1].guest, COUPLE_ACCEPT_GUEST);
  assertMust(script.turns[0], 'treat together as an explicit same-room requirement for the whole stay', 'couple');
  assertMust(script.turns[0], 'not place the guests, and not silently split them', 'couple');
  assertMust(script.turns[1], 'hold every requested bed or none', 'couple');
  assertMust(script.turns[1], 'save the ordered person-to-bed mapping', 'couple');
  assertMust(script.turns[1], 'store and show the Staff total, deposit, and remaining amount', 'couple');
  assert.equal(script.pass, 'same room for the whole stay, correct person-to-bed mapping, Staff total');
  assertFailIncludes(script, 'split booking');
  assertFailIncludes(script, 'substituted bed');
  assertFailIncludes(script, 'model amount');
}

function assertRoom10Coverage(script) {
  assert.equal(script.turns.length, 2, 'Room-10-only scenario was replaced');
  assert.equal(script.turns[0].guest, ROOM10_OPEN_GUEST);
  assert.equal(script.turns[1].guest, ROOM10_ACCEPT_GUEST);
  assert.equal(script.stock_fixture.room_7.includes('not suitable'), true);
  assertMust(script.turns[0], 'offer Room 10\'s two beds for the whole stay', 'room10');
  assertMust(script.turns[0], 'not offer Room 7 as if it were free', 'room10');
  assertMust(script.turns[1], 'book only the Room 10 beds the tool returned', 'room10');
  assert.equal(script.turns[1].must_not.includes('substitute Room 7'), true, 'Room 10 lost its substitution ban');
  assert.equal(script.pass, 'Room 10 only, both guests, whole stay, Staff total');
  assertFailIncludes(script, 'Room 7 booked');
  assertFailIncludes(script, 'split booking');
}

function assertSoloCoverage(script) {
  assert.equal(script.turns.length, 2, 'solo scenario was replaced');
  assert.equal(script.turns[0].guest, SOLO_OPEN_GUEST);
  assert.equal(script.turns[1].guest, SOLO_SHUTTLE_GUEST);
  assertMust(script.turns[0], 'not infer gender from the name', 'solo');
  assertMust(script.turns[0], 'default a solo guest to a mixed dorm unless the guest asks otherwise', 'solo');
  assertMust(script.turns[1], 'save the actual shuttle choice and the travel details the guest supplied', 'solo');
  assertMust(script.turns[1], 'offer Staff deposit and full amounts', 'solo');
  assert.equal(script.pass.includes('mixed-dorm default'), true, 'solo pass lost the mixed-dorm requirement');
  assert.equal(script.pass.includes('shuttle question'), true, 'solo pass lost the shuttle requirement');
  assertFailIncludes(script, 'gender inferred from Alex');
  assertFailIncludes(script, 'memory price');
}

function assertMixedCoverage(script) {
  assert.equal(script.turns.length, 3, 'mixed-group scenario was replaced');
  assert.equal(script.turns[0].guest, MIXED_OPEN_GUEST);
  assert.equal(script.turns[1].guest, MIXED_PACKAGES_GUEST);
  assert.equal(script.turns[2].guest, MIXED_DORM_GUEST);
  assertMust(script.turns[1], 'ask only the missing room fact about Kim', 'mixed');
  assertMust(script.turns[1], 'keep each person\'s package choice', 'mixed');
  assertMust(script.turns[2], 'preserve Nora, Luis, and Kim as separate people with their own package and bed', 'mixed');
  assertMust(script.turns[2], 'use Staff per-person money', 'mixed');
  assert.equal(script.pass.includes('one needed question'), true, 'mixed pass lost the one-question requirement');
  assert.equal(script.pass.includes('Staff per-person money'), true, 'mixed pass lost Staff money');
  assertFailIncludes(script, 'settled question asked again');
  assertFailIncludes(script, 'one shared package forced on everyone');
}

function assertScorecard(scorecard) {
  assert.equal(scorecard.paired_runs, 3);
  assert.deepEqual(scorecard.alternating_order, [
    ['v3', 'classic'],
    ['classic', 'v3'],
    ['v3', 'classic'],
  ]);
  assert.equal(scorecard.safety_floor.zero_overlapping_committed_beds_or_active_holds, true, 'overlap prevention was disabled');
  assert.deepEqual(scorecard.safety_floor.money_matches_in, SAFETY_MONEY, 'money-conservation targets were cleared');
  assert.equal(scorecard.safety_floor.no_refused_split_booked, true);
  assert.equal(scorecard.safety_floor.no_real_sends, true);
  assert.equal(scorecard.safety_floor.no_paid_cancellation_by_luna, true);
  assert.equal(scorecard.safety_floor.offset_by_nicer_prose, false);
  assert.deepEqual(scorecard.separate_probes, SAFETY_PROBES, 'race probes were removed');
  assert.equal(scorecard.beats_classic.if_both_complete_with_no_clear_experience_win, 'parity');
  assert.equal(scorecard.beats_classic.do_not_call_parity_beats, true);
}

function assertFixtureCoverageNegatives() {
  const greeting = [{ guest: 'Hello there, just saying hi today.', name: 'greeting' }];
  for (const name of ['guest-01-couple.json', 'guest-01-room10-only.json', 'guest-02-solo-package.json', 'guest-03-mixed-group.json']) {
    const stripped = JSON.parse(JSON.stringify(readJson(name)));
    stripped.turns = greeting.map((turn) => Object.assign({}, turn));
    delete stripped.pass;
    delete stripped.fail;
    assert.throws(
      () => {
        assertRealGuestDialogue(stripped);
        if (name === 'guest-01-couple.json') assertCoupleCoverage(stripped);
        if (name === 'guest-01-room10-only.json') assertRoom10Coverage(stripped);
        if (name === 'guest-02-solo-package.json') assertSoloCoverage(stripped);
        if (name === 'guest-03-mixed-group.json') assertMixedCoverage(stripped);
      },
      name + ' stayed valid after substantive turns and assertions were removed',
    );
  }
  const rebound = JSON.parse(JSON.stringify(readJson('guest-05-lifecycle.json')));
  const pay = rebound.turns.find((turn) => turn.name === 'sandbox_payment');
  pay.record_binding.bind_field = 'phone_first_booking_id';
  pay.must = ['use the cancelled booking'];
  assert.throws(
    () => assertLifecycleBinding(rebound),
    'lifecycle stayed valid after the new booking was rebound to the cancelled phone-first record',
  );
  const scorecard = JSON.parse(JSON.stringify(readJson('scorecard.json')));
  scorecard.safety_floor.zero_overlapping_committed_beds_or_active_holds = false;
  scorecard.safety_floor.money_matches_in = [];
  delete scorecard.separate_probes;
  assert.throws(
    () => assertScorecard(scorecard),
    'scorecard stayed valid after the safety floor and race probes were removed',
  );
  const removedPaid = JSON.parse(JSON.stringify(readJson('guest-05-lifecycle.json')));
  removedPaid.turns = removedPaid.turns.filter((turn) => turn.name !== 'paid_cancel');
  delete removedPaid.pass;
  delete removedPaid.fail;
  assert.throws(
    () => assertLifecycleBinding(removedPaid),
    'lifecycle stayed valid after paid cancellation and pass/fail assertions were removed',
  );
  const paidFirst = JSON.parse(JSON.stringify(readJson('guest-05-lifecycle.json')));
  const paidTurn = paidFirst.turns.find((turn) => turn.name === 'paid_cancel');
  paidFirst.turns = [paidTurn].concat(paidFirst.turns.filter((turn) => turn.name !== 'paid_cancel'));
  assert.throws(
    () => assertLifecycleBinding(paidFirst),
    'lifecycle stayed valid when paid cancellation ran before any booking or payment',
  );
  const dishonest = JSON.parse(JSON.stringify(readJson('guest-05-lifecycle.json')));
  const unpaid = dishonest.turns.find((turn) => turn.name === 'cancel_unpaid');
  unpaid.must = ['Cancel even when Staff reports paid money.'];
  unpaid.must_not = [];
  assert.throws(
    () => assertLifecycleBinding(dishonest),
    'lifecycle stayed valid after unpaid cancel was told to cancel paid money',
  );
  const reversed = JSON.parse(JSON.stringify(readJson('guest-05-lifecycle.json')));
  const complete = reversed.turns.find((turn) => turn.name === 'sandbox_payment_complete');
  complete.steps = complete.steps.slice().reverse();
  assert.throws(
    () => assertLifecycleBinding(reversed),
    'lifecycle stayed valid after checkout confirmation was placed before the sandbox checkout',
  );
  const invalidDate = JSON.parse(JSON.stringify(readJson('guest-05-lifecycle.json')));
  invalidDate.dates.check_in = '2027-99-99';
  assert.throws(
    () => assertScriptDates(invalidDate, 'guest-05-lifecycle.json'),
    'invalid calendar date 2027-99-99 stayed eligible',
  );
  const confirmedTrue = JSON.parse(JSON.stringify(readJson('guest-05-lifecycle.json')));
  confirmedTrue.dates.stock_pricing_confirmed = true;
  assert.throws(
    () => assertScriptDates(confirmedTrue, 'guest-05-lifecycle.json'),
    'stock_pricing_confirmed true stayed eligible',
  );
  const confirmedNull = JSON.parse(JSON.stringify(readJson('guest-05-lifecycle.json')));
  confirmedNull.dates.stock_pricing_confirmed = null;
  assert.throws(
    () => assertScriptDates(confirmedNull, 'guest-05-lifecycle.json'),
    'stock_pricing_confirmed null stayed eligible',
  );
  const confirmedMissing = JSON.parse(JSON.stringify(readJson('guest-05-lifecycle.json')));
  delete confirmedMissing.dates.stock_pricing_confirmed;
  assert.throws(
    () => assertScriptDates(confirmedMissing, 'guest-05-lifecycle.json'),
    'missing stock_pricing_confirmed stayed eligible',
  );
  console.log('negative removed-paid-cancel rejected');
  console.log('negative paid-cancel-before-setup rejected');
  console.log('negative dishonest-unpaid-cancel rejected');
  console.log('negative reversed-checkout-steps rejected');
  console.log('negative invalid-date rejected');
  console.log('negative stock-pricing-true rejected');
  console.log('negative stock-pricing-null rejected');
  console.log('negative missing-stock-pricing-confirmed rejected');
}

function isRealCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

function collectDateWindows(value, found) {
  if (!value || typeof value !== 'object') return;
  if (Object.prototype.hasOwnProperty.call(value, 'check_in') || Object.prototype.hasOwnProperty.call(value, 'check_out')) {
    found.push(value);
  }
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) {
    if (child && typeof child === 'object') collectDateWindows(child, found);
  }
}

function assertScriptDates(script, label) {
  assert.equal(script.dates && typeof script.dates === 'object', true, label + ' has no primary date object');
  assert.equal(script.dates.stock_pricing_confirmed, false, label + ' treated unconfirmed stock or Pricing as confirmed');
  const windows = [];
  collectDateWindows(script, windows);
  assert.equal(windows.length > 0, true, label + ' has no date window');
  for (const window of windows) {
    assert.equal(isRealCalendarDate(window.check_in), true, label + ' check_in is not a real calendar date');
    assert.equal(isRealCalendarDate(window.check_out), true, label + ' check_out is not a real calendar date');
    assert.equal(String(window.check_in).startsWith('2027-'), true, label + ' check_in is not a proposed 2027 window');
    assert.equal(String(window.check_out).startsWith('2027-'), true, label + ' check_out is not a proposed 2027 window');
    if (window === script.dates) continue;
    if (Object.prototype.hasOwnProperty.call(window, 'stock_pricing_confirmed')) {
      assert.equal(window.stock_pricing_confirmed, false, label + ' treated unconfirmed stock or Pricing as confirmed');
    }
  }
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
  assertScorecard(scorecard);

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
    assertScriptDates(script, name);
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
  assertCoupleCoverage(couple);
  assertRoom10Coverage(room10);
  assertSoloCoverage(solo);
  assertMixedCoverage(readJson('guest-03-mixed-group.json'));
  assertRemovingDialogueFails();
  assertFixtureCoverageNegatives();
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

function readMatches(call, table, id) {
  if (!call) return false;
  if (call.op === 'read' && call.table === table) {
    if (!id) return true;
    if (!call.filter) return true;
    return call.filter.id === id;
  }
  if (call.op === 'query') {
    const sql = call.sql || '';
    if (!new RegExp('\\bfrom\\s+' + table + '\\b', 'i').test(sql)) return false;
    if (!id) return true;
    return (call.params || []).includes(id);
  }
  return false;
}

function sawReadOf(observed, table, id) {
  return (observed.calls || []).some((call) => readMatches(call, table, id));
}

function snapshotValue(row, key) {
  if (!row || !Object.prototype.hasOwnProperty.call(row, key)) return null;
  return row[key];
}

function rowsMatch(before, after, keys) {
  if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) return false;
  for (let i = 0; i < before.length; i += 1) {
    for (const key of keys) {
      if (snapshotValue(before[i], key) !== snapshotValue(after[i], key)) return false;
    }
  }
  return true;
}

function isCheckoutUrl(url) {
  if (typeof url !== 'string' || url.length < 12) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (!parsed.hostname || parsed.hostname.indexOf('.') === -1) return false;
  return true;
}

function pending(reason) {
  return { pass: false, pending: true, reason };
}

function judgeAgainstOwnedStock(result, observed, trusted) {
  if (!trusted || !trusted.input || !Array.isArray(trusted.input.requestedBeds) || !trusted.seed || !Array.isArray(trusted.seed.beds)) {
    return failed('verifier lost the original hold request or stock');
  }
  const requested = trusted.input.requestedBeds;
  if (!requested.length) return failed('verifier lost the original hold request');
  const unavailable = new Set(trusted.seed.beds.filter((row) => row.available === false).map((row) => row.id));
  const blocked = requested.filter((id) => unavailable.has(id));
  const holds = tableRows(observed, 'holds');
  const heldBeds = holds.map((row) => row.bedId || row.bed_id);
  const wrote = sawWrite(observed, 'holds') || holds.length > 0;
  if (blocked.length && wrote) return failed('hold write is forbidden while a requested bed is unavailable');
  if (blocked.length && result.held === true) return failed('unavailable bed was held');
  if (heldBeds.some((id) => unavailable.has(id) || !requested.includes(id))) {
    return failed('observed a bed that was not in the verifier-owned request');
  }
  const assigned = (result.assignments || []).map((row) => row.bedId || row.bed_id);
  if (assigned.some((id) => unavailable.has(id) || !requested.includes(id))) {
    return failed('assigned a bed that was not in the verifier-owned request');
  }
  if (JSON.stringify(result.requestedBeds || requested) !== JSON.stringify(requested) && wrote) {
    return failed('handler rewrote the hold request');
  }
  if (blocked.length) {
    return pending('unavailable beds were not held; success, atomicity, and competing-writer race remain pending');
  }
  return pending('available-stock success, atomicity, and competing-writer race remain pending');
}

function judgeHoldAllOrNone(result, observed, trusted) {
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
  return judgeAgainstOwnedStock(result, observed, trusted);
}

function judgeNoSubstitution(result, observed, trusted) {
  const promise = rejectPromise(result);
  if (promise) return promise;
  if (!result || (result.ok === true && !Array.isArray(result.assignments))) return failed('bare ok can hide a substituted bed');
  if (result.substituted === true) return failed('substituted flag');
  if (!observed || !observed.touched) return unconnected();
  if (!sawRead(observed, 'beds')) return failed('substitution check did not read beds');
  return judgeAgainstOwnedStock(result, observed, trusted);
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

function judgeCancelRefusesPaid(result, observed, trusted) {
  const promise = rejectPromise(result);
  if (promise) return promise;
  if (!result) return failed('missing cancel result');
  if (result.cancelled === true && result.paid === true) return failed('paid booking was cancelled');
  if (result.paymentErased === true) return failed('payment evidence was erased');
  if (!(result.refused === true && result.cancelled !== true)) return failed('paid cancel was not an explicit refusal');
  if (!observed || !observed.touched) return unconnected();
  if (!sawRead(observed, 'payments')) return failed('cancel did not read payment state');
  const seed = trusted && trusted.seed;
  if (!seed || !Array.isArray(seed.payments) || !seed.payments.length || !Array.isArray(seed.bookings)) {
    return failed('verifier lost the paid snapshot');
  }
  const payments = tableRows(observed, 'payments');
  const bookings = tableRows(observed, 'bookings');
  if (!rowsMatch(seed.payments, payments, ['id', 'bookingId', 'amountCents', 'status'])) {
    return failed('paid payment identity, booking, or amount changed');
  }
  if (!rowsMatch(seed.bookings, bookings, ['id', 'paid', 'cancelled', 'status'])) {
    return failed('paid booking cancellation state changed');
  }
  if (payments.some((row) => row.status !== 'paid' || row.amountCents !== seed.payments.find((item) => item.id === row.id).amountCents)) {
    return failed('observed payment was erased or rewritten');
  }
  if (bookings.some((row) => row.cancelled === true || row.status === 'cancelled')) return failed('observed booking was cancelled');
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
  const storedUrl = links.map((row) => row.url).find((url) => url);
  if (!isCheckoutUrl(result.url) || (storedUrl && !isCheckoutUrl(storedUrl))) {
    return failed('stored string is not a checkout url');
  }
  return pending('sandbox provider adapter and independent transport denial were not observed');
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

function judgeTimeoutUnknown(result, observed, trusted) {
  const promise = rejectPromise(result);
  if (promise) return promise;
  if (!result) return failed('missing timeout result');
  if (result.ok === true) return failed('timeout was treated as success');
  if (result.wrote === false && result.status !== 'unknown') return failed('timeout was treated as proof of no write');
  if (result.status !== 'unknown') return failed('timeout status is not unknown');
  if (result.readBack !== true) return failed('no readback before retry');
  if (!observed || !observed.touched) return unconnected();
  const op = trusted && trusted.seed && Array.isArray(trusted.seed.operations) ? trusted.seed.operations[0] : null;
  const bookingId = op && op.bookingId;
  if (!op || op.id !== 'op1' || op.name !== 'getPaymentStatus' || !bookingId) {
    return failed('verifier lost the trusted timeout operation');
  }
  if (!sawReadOf(observed, 'operations', op.id) || !sawReadOf(observed, 'bookings', bookingId)) {
    return failed('recovery read was not the trusted operation and selected booking');
  }
  const ops = tableRows(observed, 'operations');
  if (ops.length !== 1 || ops[0].id !== op.id || ops[0].name !== op.name || ops[0].status !== op.status || ops[0].bookingId !== op.bookingId) {
    return failed('timeout operation identity changed');
  }
  if (sawWrite(observed, 'operations')) return failed('timeout retry wrote a second operation');
  const bound = tableRows(observed, 'bookings').find((row) => row.id === bookingId);
  if (!bound || bound.guest !== 'Casey-sentinel') return failed('selected booking was not read back');
  return pending('bound readback observed; retry effect and uniqueness remain pending');
}

function createdBookings(observed, trusted) {
  const seeded = trusted && trusted.seed && Array.isArray(trusted.seed.bookings) ? trusted.seed.bookings : [];
  const before = new Map(seeded.map((row) => [row.id, JSON.stringify(row)]));
  return tableRows(observed, 'bookings').filter((row) => {
    const prior = before.get(row.id);
    return prior == null || prior !== JSON.stringify(row);
  });
}

function bookingPersistenceCalls(observed) {
  return (observed.calls || []).filter((call) => {
    if ((call.op === 'write' || call.op === 'update') && call.table === 'bookings') return true;
    return call.op === 'query' && /\b(?:insert\s+into|update)\s+bookings\b/i.test(call.sql || '');
  }).length;
}

function judgeTool(name, result, observed, trusted) {
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
    const input = (trusted && trusted.input) || {};
    if (input.guest || input.tenant_id || input.beds || input.totalCents != null) {
      return failed('book input carried authority the verifier must own');
    }
    if (!sawReadOf(observed, 'holds', TRUSTED_BOOK.holdId) || !sawReadOf(observed, 'sessions', TRUSTED_BOOK.session_id) || !sawRead(observed, 'authority') || !sawWrite(observed, 'bookings')) {
      return failed('book did not read the trusted hold, session, and money before persisting');
    }
    const created = createdBookings(observed, trusted);
    const writes = bookingPersistenceCalls(observed);
    if (created.length !== 1 || writes !== 1) return failed('book wrote an extra booking');
    const booking = created[0];
    if (!result || result.bookingId !== booking.id) return failed('returned booking id does not match observed booking');
    if (booking.holdId !== TRUSTED_BOOK.holdId) return failed('book wrote an unrequested hold');
    if (!Array.isArray(booking.beds) || booking.beds.length !== TRUSTED_BOOK.beds.length || booking.beds.some((bed, index) => bed !== TRUSTED_BOOK.beds[index])) {
      return failed('book wrote an unrequested bed');
    }
    if (booking.tenant_id !== TRUSTED_BOOK.tenant_id) return failed('book wrote a foreign tenant');
    if (booking.session_id !== TRUSTED_BOOK.session_id) return failed('book wrote a foreign session');
    if (booking.guest !== TRUSTED_BOOK.guest) return failed('book wrote the wrong person');
    if (!Number.isInteger(booking.totalCents) || booking.totalCents !== TRUSTED_BOOK.totalCents || booking.totalCents < 0) {
      return failed('book wrote unauthoritative money');
    }
    if (booking.tenant_id === FOREIGN_BOOK.tenant_id || booking.session_id === FOREIGN_BOOK.session_id || booking.guest === FOREIGN_BOOK.guest) {
      return failed('book wrote a decoy');
    }
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
    const input = (trusted && trusted.input) || {};
    if (input.bookingId) return failed('getBooking was given an argument booking id');
    if (!sawReadOf(observed, 'sessions', TRUSTED_BOOK.session_id)) {
      return failed('getBooking did not read the authenticated session');
    }
    if (!sawRead(observed, 'bookings')) return failed('getBooking did not read bookings');
    const bound = tableRows(observed, 'bookings').find((row) => row.id === TRUSTED_BOOK.bookingId);
    const decoy = tableRows(observed, 'bookings').find((row) => row.id === 'phone-first');
    if (!result || !bound || result.bookingId !== bound.id || result.guest !== bound.guest) {
      return failed('getBooking did not return the session-bound record');
    }
    if (result.bookingId === 'phone-first' || (decoy && result.guest === decoy.guest)) {
      return failed('getBooking returned the phone-first booking');
    }
    if (result.tenant_id && result.tenant_id !== TRUSTED_BOOK.tenant_id) return failed('getBooking returned a foreign tenant');
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
  return {
    operations: [{ id: 'op1', name: 'getPaymentStatus', status: 'unknown', bookingId: 'b-bound' }],
    bookings: [{ id: 'b-bound', guest: 'Casey-sentinel', status: 'unpaid' }],
    rooms: [],
  };
}

function toolFixture(name) {
  if (name === 'book') return { holdId: TRUSTED_BOOK.holdId, session_id: TRUSTED_BOOK.session_id };
  if (name === 'releaseHold') return { holdId: 'hold-1' };
  if (name === 'getBooking') return { session_id: TRUSTED_BOOK.session_id };
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
  if (name === 'book') {
    return {
      holds: [{ id: TRUSTED_BOOK.holdId, beds: TRUSTED_BOOK.beds.slice(), status: 'active', tenant_id: TRUSTED_BOOK.tenant_id, session_id: TRUSTED_BOOK.session_id }],
      sessions: [{ id: TRUSTED_BOOK.session_id, tenant_id: TRUSTED_BOOK.tenant_id, guest: TRUSTED_BOOK.guest, selected_booking_id: null }],
      authority: [{ id: 'staff-money', totalCents: TRUSTED_BOOK.totalCents, depositCents: 101010 }],
      bookings: [],
    };
  }
  if (name === 'releaseHold') return { holds: [{ id: 'hold-1', status: 'active' }], bookings: [] };
  if (name === 'getBooking') {
    return {
      sessions: [{ id: TRUSTED_BOOK.session_id, tenant_id: TRUSTED_BOOK.tenant_id, selected_booking_id: TRUSTED_BOOK.bookingId, guest: TRUSTED_BOOK.guest }],
      bookings: [
        { id: 'phone-first', guest: 'Wrong person', tenant_id: FOREIGN_BOOK.tenant_id, session_id: FOREIGN_BOOK.session_id },
        { id: TRUSTED_BOOK.bookingId, guest: TRUSTED_BOOK.guest, bound: true, tenant_id: TRUSTED_BOOK.tenant_id, session_id: TRUSTED_BOOK.session_id },
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
  if (name === 'book') {
    return 'TODO(skip): book must persist exactly one trusted booking; an extra, foreign, or unrequested booking is a fail';
  }
  if (name === 'getBooking') {
    return 'TODO(skip): getBooking must read the authenticated session binding, not a caller-selected booking id';
  }
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
    result = await fn(harness.pg, input, {
      tenantId: 'wolfhouse-somo',
      sessionId: 'luna-v3:contract-observer',
      destination: 'france-test',
      authenticated: true,
    });
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
  const verdict = judge(result, observed, { input, seed });
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
      (result, observed, trusted) => judgeTool(name, result, observed, trusted),
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
      const ops = await pg.read('operations', { id: 'op1' });
      await pg.read('bookings', { id: ops[0].bookingId });
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
      const sessions = await pg.read('sessions', { id: input.session_id });
      const money = await pg.read('authority');
      const hold = holds[0];
      const session = sessions[0];
      const stored = await pg.write('bookings', {
        holdId: hold.id,
        beds: hold.beds,
        status: 'booked',
        tenant_id: session.tenant_id,
        session_id: session.id,
        guest: session.guest,
        totalCents: money[0].totalCents,
      });
      return { ok: true, bookingId: stored.id, holdId: hold.id };
    },
    async releaseHold(pg, input) {
      await pg.read('holds', { id: input.holdId });
      await pg.update('holds', input.holdId, { status: 'released' });
      return { ok: true, holdId: input.holdId, status: 'released' };
    },
    async getBooking(pg, input) {
      const sessions = await pg.read('sessions', { id: input.session_id });
      const rows = await pg.read('bookings', { id: sessions[0].selected_booking_id });
      return { ok: true, bookingId: rows[0].id, guest: rows[0].guest, tenant_id: sessions[0].tenant_id };
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
  const unproven = new Set([
    'hold_all_or_none',
    'no_bed_substitution',
    'payment_link_returned_not_sent',
    'timeout_unknown',
  ]);
  for (const contract of HANDLER_CONTRACTS) {
    const row = await evaluateExport(
      contract.id,
      contract.todo,
      probes[contract.exportName],
      contractFixture(contract.id),
      seedFor(contract.id),
      contract.judge,
    );
    if (unproven.has(contract.id)) {
      assert.equal(row.status, 'pending', contract.id + ' unproven boundary was certified: ' + row.status + ' ' + row.reason);
      assert.notEqual(row.status, 'pass', contract.id + ' passed without its real boundary');
    } else {
      assert.equal(row.status, 'pass', contract.id + ' connected probe did not pass: ' + row.reason);
    }
  }
  for (const name of uncoveredToolNames()) {
    const row = await evaluateExport(
      'tool_' + name,
      'probe',
      probes[name],
      toolFixture(name),
      seedForTool(name),
      (result, observed, trusted) => judgeTool(name, result, observed, trusted),
    );
    assert.equal(row.status, 'pass', name + ' connected probe did not pass: ' + row.reason);
  }
}

async function assertNotPass(row, label) {
  assert.notEqual(row.status, 'pass', label + ' passed: ' + JSON.stringify(row));
}

async function assertReviewNegatives() {
  async function writeUnavailable(pg, input) {
    await pg.read('beds');
    for (const bedId of input.requestedBeds || []) {
      await pg.write('holds', { holdId: 'hold-bad', bedId });
    }
    const requested = input.requestedBeds || [];
    return {
      held: true,
      holdId: 'hold-bad',
      requestedCount: requested.length,
      requestedBeds: requested,
      assignments: requested.map((bedId) => ({ bedId })),
      substituted: false,
    };
  }
  for (const id of ['hold_all_or_none', 'no_bed_substitution']) {
    const contract = HANDLER_CONTRACTS.find((item) => item.id === id);
    const row = await evaluateExport(id, contract.todo, writeUnavailable, contractFixture(id), seedFor(id), contract.judge);
    assert.equal(row.status, 'fail', 'negative unavailable-holds ' + id + ' was ' + row.status + ' ' + row.reason);
    await assertNotPass(row, 'negative unavailable-holds ' + id);
  }

  const cancel = HANDLER_CONTRACTS.find((item) => item.id === 'cancel_unpaid_refuses_paid');
  async function destroyPaid(pg) {
    const payments = await pg.read('payments');
    await pg.update('payments', payments[0].id, { amountCents: 0, bookingId: 'wrong-booking', status: 'paid' });
    const bookings = await pg.read('bookings');
    await pg.update('bookings', bookings[0].id, { status: 'cancelled' });
    return { refused: true, cancelled: false, paid: true, paymentErased: false };
  }
  const destroyed = await evaluateExport(
    cancel.id,
    cancel.todo,
    destroyPaid,
    contractFixture(cancel.id),
    seedFor(cancel.id),
    cancel.judge,
  );
  assert.equal(destroyed.status, 'fail', 'negative paid-state-destroyed was ' + destroyed.status + ' ' + destroyed.reason);
  await assertNotPass(destroyed, 'negative paid-state-destroyed');

  async function wrongTenant(pg) {
    await pg.read('holds');
    const stored = await pg.write('bookings', {
      holdId: 'hold-1',
      beds: ['unrequested-bed'],
      tenant_id: 'foreign-tenant',
      session_id: 'foreign-session',
      guest: 'wrong-person',
      totalCents: -1,
      status: 'booked',
    });
    return { ok: true, bookingId: stored.id, holdId: 'hold-1' };
  }
  const wrongBook = await evaluateExport(
    'tool_book',
    toolTodo('book', true),
    wrongTenant,
    toolFixture('book'),
    seedForTool('book'),
    (result, observed, trusted) => judgeTool('book', result, observed, trusted),
  );
  assert.equal(wrongBook.status, 'fail', 'negative wrong-tenant-booking was ' + wrongBook.status + ' ' + wrongBook.reason);
  await assertNotPass(wrongBook, 'negative wrong-tenant-booking');

  async function extraForeignBooking(pg, input) {
    const holds = await pg.read('holds', { id: input.holdId });
    const sessions = await pg.read('sessions', { id: input.session_id });
    const money = await pg.read('authority');
    const hold = holds[0];
    const session = sessions[0];
    const stored = await pg.write('bookings', {
      holdId: hold.id,
      beds: hold.beds,
      status: 'booked',
      tenant_id: session.tenant_id,
      session_id: session.id,
      guest: session.guest,
      totalCents: money[0].totalCents,
    });
    await pg.write('bookings', {
      holdId: 'another-hold',
      tenant_id: FOREIGN_BOOK.tenant_id,
      session_id: FOREIGN_BOOK.session_id,
      guest: FOREIGN_BOOK.guest,
      beds: FOREIGN_BOOK.beds.slice(),
      totalCents: FOREIGN_BOOK.totalCents,
    });
    return { ok: true, bookingId: stored.id, holdId: hold.id };
  }
  const extraBook = await evaluateExport(
    'tool_book',
    toolTodo('book', true),
    extraForeignBooking,
    toolFixture('book'),
    seedForTool('book'),
    (result, observed, trusted) => judgeTool('book', result, observed, trusted),
  );
  assert.equal(extraBook.status, 'fail', 'negative extra-foreign-booking was ' + extraBook.status + ' ' + extraBook.reason);
  assert.equal(extraBook.reason, 'book wrote an extra booking', 'extra booking was not the stated failure: ' + extraBook.reason);
  await assertNotPass(extraBook, 'negative extra-foreign-booking');

  async function argumentId(pg, input) {
    const id = input.bookingId || 'phone-first';
    const rows = await pg.read('bookings', { id });
    const row = rows[0] || { id: 'phone-first', guest: 'Wrong person' };
    return { ok: true, bookingId: row.id, guest: row.guest };
  }
  const argument = await evaluateExport(
    'tool_getBooking',
    toolTodo('getBooking', true),
    argumentId,
    toolFixture('getBooking'),
    seedForTool('getBooking'),
    (result, observed, trusted) => judgeTool('getBooking', result, observed, trusted),
  );
  assert.equal(argument.status, 'fail', 'negative argument-id getBooking was ' + argument.status + ' ' + argument.reason);
  await assertNotPass(argument, 'negative argument-id getBooking');

  const link = HANDLER_CONTRACTS.find((item) => item.id === 'payment_link_returned_not_sent');
  async function invalidCheckout(pg) {
    await pg.read('bookings');
    await pg.write('links', { url: 'not-a-checkout-url', mode: 'test' });
    return { ok: true, url: 'not-a-checkout-url', sent: false, mode: 'test' };
  }
  const badLink = await evaluateExport(
    link.id,
    link.todo,
    invalidCheckout,
    contractFixture(link.id),
    seedFor(link.id),
    link.judge,
  );
  assert.equal(badLink.status, 'fail', 'negative invalid-checkout was ' + badLink.status + ' ' + badLink.reason);
  await assertNotPass(badLink, 'negative invalid-checkout');

  const timeout = HANDLER_CONTRACTS.find((item) => item.id === 'timeout_unknown');
  async function unrelatedRecovery(pg) {
    await pg.read('rooms');
    return { ok: false, status: 'unknown', readBack: true, wrote: null };
  }
  const unrelated = await evaluateExport(
    timeout.id,
    timeout.todo,
    unrelatedRecovery,
    contractFixture(timeout.id),
    seedFor(timeout.id),
    timeout.judge,
  );
  assert.equal(unrelated.status, 'fail', 'negative unrelated-recovery-read was ' + unrelated.status + ' ' + unrelated.reason);
  await assertNotPass(unrelated, 'negative unrelated-recovery-read');

  async function declaredTestUrl(pg) {
    await pg.read('bookings');
    const stored = await pg.write('links', { url: 'https://pay.test/sandbox-deposit', mode: 'test', bookingId: 'b1' });
    return { ok: true, url: stored.url, sent: false, mode: 'test' };
  }
  const declared = await evaluateExport(link.id, link.todo, declaredTestUrl, contractFixture(link.id), seedFor(link.id), link.judge);
  assert.equal(declared.status, 'pending', 'self-declared test URL was certified: ' + declared.status + ' ' + declared.reason);
  await assertNotPass(declared, 'self-declared test URL');

  async function refuseUnavailable(pg, input) {
    await pg.read('beds');
    return { held: false, substituted: false, requestedBeds: input.requestedBeds || [], assignments: [] };
  }
  for (const id of ['hold_all_or_none', 'no_bed_substitution']) {
    const contract = HANDLER_CONTRACTS.find((item) => item.id === id);
    const row = await evaluateExport(id, contract.todo, refuseUnavailable, contractFixture(id), seedFor(id), contract.judge);
    assert.equal(row.status, 'pending', id + ' refusal certified the unproven hold contract: ' + row.status + ' ' + row.reason);
    await assertNotPass(row, id + ' refusal');
  }

  console.log('negative unavailable-holds rejected');
  console.log('negative paid-state-destroyed rejected');
  console.log('negative wrong-tenant-booking rejected');
  console.log('negative extra-foreign-booking rejected');
  console.log('negative invalid-checkout rejected');
  console.log('negative unrelated-recovery-read rejected');
  console.log('negative fixture-coverage rejected');
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
    await assertReviewNegatives();
    structural.push('fixtures', 'stub_rejection', 'fake_handlers_not_pass', 'connected_observation', 'query_observation', 'review_negatives');
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
