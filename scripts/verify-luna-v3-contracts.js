'use strict';

// Luna v3 offline contracts. Handler tests stay pending until Skip's
// scripts/lib/model-led-luna/ exists. A missing handler is not a pass.
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

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8'));
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
  }

  const refusal = readJson('guest-04-refusal.json');
  assert.equal(refusal.stock_fixture.same_room_pair, 'none');
  const refusalText = JSON.stringify(refusal);
  assert.equal(refusalText.includes('payment link'), true);
  assert.equal(refusalText.includes('No. We will not split.'), true);
  assert.equal(refusal.fail.includes('split booking'), true);
  const lifecycle = readJson('guest-05-lifecycle.json');
  assert.equal(lifecycle.payment.real_charge, false);
  assert.equal(lifecycle.turns.some((turn) => turn.name === 'timeout_retry'), true);
  const solo = readJson('guest-02-solo-package.json');
  assert.equal(solo.guests[0].gender_stated, false);
  assert.equal(solo.quote_style.owner_doc_edited_here, false);
}

function failed(reason) {
  return { pass: false, reason };
}

function judgeHoldAllOrNone(result) {
  if (!result || result.ok === true && !result.assignments) {
    return failed('bare ok is not an all-or-none hold');
  }
  if (result.partial === true || (Array.isArray(result.assignments) && result.assignments.length === 1 && result.requestedCount > 1)) {
    return failed('partial hold');
  }
  if (result.held === true && !result.holdId) return failed('held without a persisted hold id');
  if (result.held === false && result.holdId) return failed('refusal still returned a hold id');
  if (result.held === true && Array.isArray(result.assignments) && result.assignments.length === result.requestedCount) {
    return { pass: true };
  }
  if (result.held === false && !result.holdId && result.unknown !== true) return { pass: true };
  return failed('hold result did not prove all-or-none');
}

function judgeNoSubstitution(result) {
  if (!result || result.ok === true && !Array.isArray(result.assignments)) {
    return failed('bare ok can hide a substituted bed');
  }
  if (result.substituted === true) return failed('substituted flag');
  const requested = result.requestedBeds || [];
  const assigned = (result.assignments || []).map((row) => row.bedId || row.bed_id);
  if (!requested.length) return failed('no requested beds to compare');
  if (assigned.some((bed) => !requested.includes(bed))) return failed('assigned a bed that was not requested');
  if (result.held === true && assigned.length !== requested.length) return failed('held a different set than requested');
  return { pass: true };
}

function judgeStaffMoney(result) {
  if (!result || result.ok === true && result.totalCents == null) return failed('bare ok is not Staff money');
  if (result.source !== 'staff_pricing') return failed('money source is not staff_pricing');
  if (result.acceptedModelAmount === true) return failed('model amount was accepted');
  if (!Number.isInteger(result.totalCents) || !Number.isInteger(result.depositCents)) return failed('cents are not integers');
  return { pass: true };
}

function judgeCancelRefusesPaid(result) {
  if (!result) return failed('missing cancel result');
  if (result.cancelled === true && result.paid === true) return failed('paid booking was cancelled');
  if (result.paymentErased === true) return failed('payment evidence was erased');
  if (result.refused === true && result.cancelled !== true) return { pass: true };
  return failed('paid cancel was not an explicit refusal');
}

function judgeLinkNotSent(result) {
  if (!result || result.ok === true && !result.url) return failed('bare ok is not a returned link');
  if (typeof result.url !== 'string' || !result.url) return failed('missing url');
  if (result.sent === true) return failed('link was sent');
  if (result.whatsapp || result.sms || result.email) return failed('a transport was used');
  if (result.mode !== 'test') return failed('link mode is not test');
  return { pass: true };
}

function judgeScopedNotes(result) {
  if (!result || result.ok === true && !result.noteId) return failed('bare ok is not a scoped note');
  if (result.replacedSharedHouseNotes === true) return failed('shared General Notes were replaced');
  if (result.target === 'tenant_house_notes') return failed('write targeted the shared house-notes document');
  if (result.scope !== 'luna-v3') return failed('note scope is not luna-v3');
  if (!result.noteId) return failed('missing note id');
  return { pass: true };
}

function judgeTimeoutUnknown(result) {
  if (!result) return failed('missing timeout result');
  if (result.ok === true) return failed('timeout was treated as success');
  if (result.wrote === false && result.status !== 'unknown') return failed('timeout was treated as proof of no write');
  if (result.status !== 'unknown') return failed('timeout status is not unknown');
  if (result.readBack !== true) return failed('no readback before retry');
  return { pass: true };
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
}

function loadHandlers() {
  if (!fs.existsSync(handlerIndex)) return null;
  // Stay off Skip's tree until the file exists. Requiring a missing path is not a pass.
  return require(handlerIndex);
}

function runHandlerContracts(api) {
  const rows = [];
  if (!api) {
    for (const contract of HANDLER_CONTRACTS) {
      rows.push({ id: contract.id, status: 'pending', todo: contract.todo });
    }
    for (const name of SECTION3_TOOLS) {
      if (!HANDLER_CONTRACTS.some((contract) => contract.exportName === name)) {
        rows.push({
          id: 'tool_' + name,
          status: 'pending',
          todo: 'TODO(skip): export ' + name + ' from scripts/lib/model-led-luna/index.js; do not compose a guest reply',
        });
      }
    }
    return rows;
  }
  for (const contract of HANDLER_CONTRACTS) {
    const fn = api[contract.exportName];
    if (typeof fn !== 'function') {
      rows.push({ id: contract.id, status: 'pending', todo: contract.todo });
      continue;
    }
    let result;
    try {
      result = fn(contractFixture(contract.id));
    } catch (err) {
      rows.push({ id: contract.id, status: 'fail', todo: contract.todo, reason: err.message });
      continue;
    }
    const verdict = contract.judge(result);
    rows.push({
      id: contract.id,
      status: verdict.pass ? 'pass' : 'fail',
      todo: contract.todo,
      reason: verdict.reason || '',
    });
  }
  return rows;
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

function main() {
  const structural = [];
  try {
    assertFixtures();
    stubProbe();
    structural.push('fixtures', 'stub_rejection');
  } catch (err) {
    console.error('FAIL structural ' + err.message);
    process.exit(1);
  }
  const rows = runHandlerContracts(loadHandlers());
  const pending = rows.filter((row) => row.status === 'pending');
  const failed = rows.filter((row) => row.status === 'fail');
  const passed = rows.filter((row) => row.status === 'pass');
  console.log('structural ' + structural.join(',') + ' pass');
  for (const row of rows) {
    console.log(row.status.toUpperCase() + ' ' + row.id + (row.todo ? ' ' + row.todo : '') + (row.reason ? ' ' + row.reason : ''));
  }
  console.log('handler_pass ' + passed.length + ' handler_pending ' + pending.length + ' handler_fail ' + failed.length);
  if (failed.length) {
    console.error('FAIL handler contract');
    process.exit(1);
  }
  if (pending.length) {
    console.error('PENDING not PASS; handlers missing or incomplete');
    process.exit(2);
  }
  if (passed.length !== HANDLER_CONTRACTS.length) {
    console.error('FAIL contract count');
    process.exit(1);
  }
  console.log('PASS luna v3 contracts');
}

main();
