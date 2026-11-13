'use strict';

// Actual Python completion owner -> Staff atomic SQL/readback -> JS wrapper ->
// Python completion adapter. Only checkout/provider transport is simulated.
// No network, credentials, real guests, bookings, Stripe or WhatsApp.
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { PGlite, seed, runScenario } = require('./verify-missing-payment-choice-always-saves');
const { handleBotBookingCreateFromPlan } = require('./lib/staff-bot-v2-routes');
const root = path.resolve(__dirname, '..');
const pythonEnv = {
  PATH: process.env.PATH,
  PYTHONDONTWRITEBYTECODE: '1',
  PYTHONPATH: [path.join(root, 'docker/hermes-staging'),
    path.join(root, 'docker/hermes-staging/plugins')].join(path.delimiter),
  LUNA_CLIENT_SLUG: 'wolfhouse-somo',
};

function python(code, input) {
  return JSON.parse(execFileSync('python3', ['-B', '-c', code], {
    cwd: root, env: pythonEnv, encoding: 'utf8', input: JSON.stringify(input),
  }));
}
const infer = `import json,sys,socket
from unittest.mock import patch
from wolfhouse import accepted_quote as owner
v=json.load(sys.stdin)
with patch.object(socket.socket,'connect',side_effect=AssertionError('NETWORK FORBIDDEN')):
 result=owner._with_inferred_guest_payment(v['params'],v['state'])
print(json.dumps(result))`;
const complete = `import json,sys,socket
from unittest.mock import patch
import wolfhouse_staff_api as plugin
v=json.load(sys.stdin); calls=[]
def transport(p,b):
 calls.append({'path':p,'body':b})
 if p=='/booking-create-from-plan':return v['receipt']
 if v['pending']:raise AssertionError('Pending tier attempted '+p)
 if p=='/booking-guests/payment-status':
  guest=next(g for g in v['guests'] if g['guest_number']==b['guest_number'])
  return {'success':True,'booking_guest_id':guest['id']}
 if p.endswith('/create-payment-link'):
  guest=next(g for g in v['guests'] if g['id']==p.split('/')[-2])
  amount=guest['deposit_amount_cents'] if b['payment_target']=='deposit' else guest['metadata']['subtotal_cents']
  return {'success':True,'guest_payment_url':'https://checkout.invalid/offline',
          'payment_id':'offline-link','payment_target':b.get('payment_target'),
          'amount_due_cents':amount}
 raise AssertionError('Unexpected operation '+p)
with patch.object(plugin,'_post_bot',side_effect=transport),patch.object(socket.socket,'connect',side_effect=AssertionError('NETWORK FORBIDDEN')):
 result=json.loads(plugin._commit_and_complete_booking(v['payload']))
print(json.dumps({'result':result,'calls':calls}))`;

async function wrapper(payload, receipt, guests) {
  const targets = [];
  let output;
  await handleBotBookingCreateFromPlan({ headers: { 'x-luna-guest-phone': payload.phone } }, {}, null, 'bot_token', {
    DEFAULT_CLIENT: 'wolfhouse-somo', STAFF_AUTH_REQUIRED: false,
    STRIPE_LINKS_ENABLED: true, STRIPE_SECRET_KEY: 'offline-not-a-credential',
    readBody: async () => JSON.stringify(payload),
    sendJSON: (_res, status, body) => { output = { status, body }; },
    handleBotBookingCreate: async (_req, res) => {
      // Exact receipt from the real SQL COMMIT or idempotent lookup above.
      res.writeHead(receipt.status); res.end(JSON.stringify(receipt.body));
    },
    handleBotGuestPaymentCreateLink: async (id, req, res) => {
      let raw = ''; req.on('data', chunk => { raw += chunk; });
      const body = JSON.parse(raw);
      targets.push(body.payment_target);
      const guest = guests.find(row => row.id === id);
      assert.ok(guest, 'link must target the guest read back from SQL');
      const amount = body.payment_target === 'deposit'
        ? guest.deposit_amount_cents : guest.metadata.subtotal_cents;
      res.end(JSON.stringify({ success: true, booking_guest_id: id,
        payment_target: body.payment_target, amount_due_cents: amount,
        checkout_url: `https://checkout.invalid/${id}` }));
    },
  });
  return { output, targets };
}

async function main() {
  const db = new PGlite();
  const failures = [];
  const split = { payment_link_distribution: 'separate', per_guest_payment_links: true };
  const awaiting = { ...split, payment_choice: 'deposit', ask_payment_amount: true };
  const cases = [
    ['separate', 'separate', {}, {}, true],
    ['separate-plus-question', 'Separate links, and what time is check-in?', {}, {}, true],
    ['together', 'together', {}, {}, true],
    ['model-default-deposit-separate', 'separate', { payment_choice: 'deposit' }, {}, true],
    ['model-default-deposit-together', 'pay together', { payment_choice: 'deposit' }, {}, true],
    ['prior-full-model-default', 'separate', { payment_choice: 'deposit' }, { plan: { payment_choice: 'full' } }, false, 'full'],
    ['legacy-provisional-deposit', 'separate', awaiting, {}, true],
    ['prior-pending', 'separate', {}, { plan: awaiting }, true],
    ['explicit-deposit', 'separate deposit', {}, {}, false],
    ['explicit-full', 'separate full', {}, {}, false],
    ['prior-full', 'separate', {}, { plan: { payment_choice: 'full' } }, false],
    ['answer-deposit', 'deposit', awaiting, {}, false],
    ['answer-full', 'full', awaiting, {}, false],
  ];
  try {
    await seed(db);
    for (const [label, raw, params, state, pending, expectedChoice] of cases) {
      try {
        const inferred = python(infer, { params, state: { ...state, current_turn: { raw } } });
        // First prove the real save, metadata and retry identity. Never gate INSERT
        // on payment tier. This fails on the original inferred-deposit mismatch.
        const sql = await runScenario(db, `owner-${label}`, inferred, pending);
        if (expectedChoice) assert.equal(inferred.payment_choice, expectedChoice);
        for (const receipt of [sql.created, sql.retry]) {
          const { output, targets } = await wrapper(sql.payload, receipt, sql.related.booking_guests);
          assert.equal(output.status, receipt.status);
          assert.equal(output.body.booking_id, sql.saved.id);
          assert.equal(output.body.payment_choice_pending, pending);
          if (pending) {
            assert.deepEqual(targets, [], `${label}: no checkout attempts before tier selection`);
            assert.equal(output.body.next_action, 'ask_deposit_or_full');
            assert.ok(!output.body.guest_payment_links?.length);
            const { result, calls } = python(complete, { payload: sql.payload, receipt: output.body, pending, guests: sql.related.booking_guests });
            assert.deepEqual(calls.map(call => call.path), ['/booking-create-from-plan']);
            assert.equal(result.booking_id, sql.saved.id);
            assert.equal(result.next_action, 'ask_deposit_or_full');
            assert.equal(result.ask_payment_amount, true);
            assert.equal(result.payment_choice_pending, true);
            assert.equal(result.staff_review_needed, false);
            assert.equal(result.needs_human, false);
            assert.ok(!result.guest_payment_links?.length);
            assert.ok(!result.secure_payment_url);
          } else {
            const target = inferred.payment_choice === 'full' ? 'full_share' : 'deposit';
            assert.deepEqual(targets, receipt.status === 201 ? [target, target] : []);
            const { result, calls } = python(complete, { payload: sql.payload, receipt: output.body, pending, guests: sql.related.booking_guests });
            const linkCalls = calls.filter(call => call.path.endsWith('/create-payment-link'));
            assert.equal(linkCalls.length, 2, 'explicit tier still completes both saved guests');
            assert.ok(linkCalls.every(call => call.body.payment_target === target));
            assert.equal(result.next_action, 'send_per_guest_payment_links');
            assert.equal(result.payment_choice_pending, false);
            assert.equal(result.ask_payment_amount, false);
          }
        }
        console.log(`PASS owner-to-SQL-to-links ${label}: saved once; 201/200; ${pending ? 'ask deposit/full, zero link attempts' : 'explicit tier completes correct guest targets'}`);
      } catch (error) {
        failures.push(label);
        console.error(`FAIL ${label}: ${error.stack || error}`);
        await db.exec('ROLLBACK');
      }
    }
    assert.deepEqual(failures, [], 'all owner/SQL/payment cross-boundary cases');
    console.log(`PASS separate tier after save: ${cases.length} real SQL scenarios, idempotent retries, no network/Stripe/WhatsApp`);
  } finally { await db.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
