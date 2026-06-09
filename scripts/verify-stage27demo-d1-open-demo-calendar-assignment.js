/**
 * Stage 27demo-d.1 — Verifier for open demo calendar bed assignment.
 *
 * Usage:
 *   npm run verify:stage27demo-d1-open-demo-calendar-assignment
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API = path.join(__dirname, 'staff-query-api.js');
const GATE = path.join(__dirname, 'lib', 'open-demo-whatsapp-gate.js');
const ASSIGN = path.join(__dirname, 'lib', 'open-demo-booking-bed-assign.js');
const PLAN = path.join(__dirname, 'lib', 'assign-booking-beds-plan.js');
const HARNESS = path.join(__dirname, 'run-open-demo-whatsapp-inbound-dry-run.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const DOC = path.join(ROOT, 'docs', 'STAGE-27DEMO-D-OPEN-DEMO-BOOKING-WRITE-CALENDAR.md');
const SCRIPT = 'verify:stage27demo-d1-open-demo-calendar-assignment';

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage27demo-d1-open-demo-calendar-assignment.js  (Stage 27demo-d.1)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

const src = fs.readFileSync(API, 'utf8');
const gateSrc = fs.readFileSync(GATE, 'utf8');
const assignSrc = fs.readFileSync(ASSIGN, 'utf8');
const planSrc = fs.readFileSync(PLAN, 'utf8');
const harnessSrc = fs.readFileSync(HARNESS, 'utf8');
const doc = fs.readFileSync(DOC, 'utf8');

const handlerStart = src.indexOf('async function handleBotOpenDemoWhatsAppInboundDryRun(');
const handlerEnd = src.indexOf('\nfunction parseGuestSimulatorChain(', handlerStart);
const handler = handlerStart > -1 && handlerEnd > handlerStart
  ? src.slice(handlerStart, handlerEnd)
  : '';

section('A. Gate + assignment module');

if (gateSrc.includes('wantsAssignDemoBedConfirmed')) pass('A1', 'assign_demo_bed_confirmed helper');
else fail('A1', 'assign flag helper missing');

if (gateSrc.includes('evaluateOpenDemoBedAssignmentWriteReady')) pass('A2', 'assignment readiness evaluator');
else fail('A2', 'assignment readiness missing');

if (fs.existsSync(ASSIGN)) pass('A3', 'open-demo-booking-bed-assign.js exists');
else fail('A3', 'assignment module missing');

if (assignSrc.includes('loadAssignPlan') && planSrc.includes('loadAssignPlan')) {
  pass('A4', 'reuses loadAssignPlan from assign-booking-beds-plan');
} else {
  fail('A4', 'loadAssignPlan reuse missing');
}

if (assignSrc.includes('overlap') || assignSrc.includes('hasOverlaps')) {
  pass('A5', 'conflict check via assign plan overlaps');
} else {
  fail('A5', 'conflict check missing');
}

if (assignSrc.includes('reused_existing') && assignSrc.includes('existing_booking_beds')) {
  pass('A6', 'idempotency/reused_existing assignment path');
} else {
  fail('A6', 'reused assignment path missing');
}

if (assignSrc.includes('skipped_no_safe_bed')) pass('A7', 'skipped_no_safe_bed status');
else fail('A7', 'skipped_no_safe_bed missing');

try {
  execSync(`node --check "${ASSIGN}"`, { stdio: 'pipe' });
  pass('A8', 'assignment module passes node --check');
} catch {
  fail('A8', 'assignment module syntax error');
}

const assignBlockStart = handler.indexOf('if (assignDemoBedConfirmed)');
const assignBlock = assignBlockStart > -1 ? handler.slice(assignBlockStart, assignBlockStart + 2800) : '';

section('B. Handler integration');

if (handler.includes('wantsAssignDemoBedConfirmed') || handler.includes('assign_demo_bed_confirmed')) {
  pass('B1', 'handler reads assign_demo_bed_confirmed');
} else {
  fail('B1', 'assign flag not wired');
}

if (handler.includes('evaluateOpenDemoBookingWriteGate') && handler.includes('assignDemoBedConfirmed')) {
  pass('B2', 'assignment behind OPEN_DEMO_BOOKING_WRITES_ENABLED gate');
} else {
  fail('B2', 'assignment gate missing');
}

if (handler.includes('create_demo_hold_draft_confirmed_required') || handler.includes('createHoldDraftConfirmed')) {
  pass('B3', 'assignment requires create_demo_hold_draft_confirmed');
} else {
  fail('B3', 'create flag prerequisite missing');
}

if (handler.includes('runOpenDemoBookingBedAssignApproved')) {
  pass('B4', 'reuses runOpenDemoBookingBedAssignApproved');
} else {
  fail('B4', 'assignment helper not called');
}

if (handler.includes('assignment_write_status')) {
  pass('B5', 'response includes assignment_write_status');
} else {
  fail('B5', 'assignment_write_status missing');
}

if (handler.includes('calendar_visible_expected') || assignSrc.includes('calendar_visible_expected')) {
  pass('B6', 'calendar_visible_expected field');
} else {
  fail('B6', 'calendar_visible_expected missing');
}

if (!handler.includes('runGuestStripeTestLinkCreateApproved')) {
  pass('B7', 'handler does not call Stripe link helper');
} else {
  fail('B7', 'Stripe link helper called');
}

if (!assignBlock.includes('evaluateGuestReplySendRouteWithPause')) {
  pass('B8', 'assignment block does not call WhatsApp send');
} else {
  fail('B8', 'WhatsApp send in assignment block');
}

try {
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  pass('B9', 'staff-query-api.js passes node --check');
} catch {
  fail('B9', 'staff-query-api.js syntax error');
}

if (handler.includes('const sendLiveReplyConfirmed = wantsSendLiveReplyConfirmed(body)')) {
  pass('B10', 'sendLiveReplyConfirmed bound from wantsSendLiveReplyConfirmed');
} else {
  fail('B10', 'sendLiveReplyConfirmed variable missing or misnamed');
}

if (handler.includes('send_live_reply_confirmed: sendLiveReplyConfirmed')) {
  pass('B11', 'response send_live_reply_confirmed uses sendLiveReplyConfirmed');
} else {
  fail('B11', 'send_live_reply_confirmed must map sendLiveReplyConfirmed (typo guard)');
}

if (handler.includes('send_live_reply_confirmed: sendLiveConfirmed')) {
  fail('B12', 'stale sendLiveConfirmed identifier in response body');
} else {
  pass('B12', 'no sendLiveConfirmed typo in response mapping');
}

section('C. Harness and docs');

if (harnessSrc.includes('--assign-demo-bed-confirmed')) pass('C1', 'harness supports --assign-demo-bed-confirmed');
else fail('C1', 'harness assign flag missing');

if (harnessSrc.includes('assign_demo_bed_confirmed')) pass('C2', 'harness sends assign flag on final turn');
else fail('C2', 'harness payload flag missing');

if (harnessSrc.includes('booking-deposit-write-clean') && harnessSrc.includes('34600995556')) {
  pass('C5', 'clean hosted proof fixture with alternate demo phone');
} else {
  fail('C5', 'booking-deposit-write-clean fixture or phone default missing');
}

if (harnessSrc.includes('August 18 to August 25')) {
  pass('C6', 'clean fixture uses non-Jul-10–17 date window');
} else {
  fail('C6', 'clean fixture date window missing');
}

if (/27demo-d\.1|assign_demo_bed|booking_beds|bed grid|hold-only/i.test(doc)) {
  pass('C3', 'docs explain hold-only vs grid + d.1 assignment');
} else {
  fail('C3', 'docs missing d.1 / grid note');
}

if (/WH-G27-0BB996236D|hosted proof|27demo-d hosted/i.test(doc)) {
  pass('C4', 'docs mention 27demo-d hosted proof');
} else {
  fail('C4', 'hosted proof note missing');
}

section('D. package.json');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('D1', `${SCRIPT} npm script`);
else fail('D1', `${SCRIPT} npm script missing`);

section('E. Gate unit smoke');

try {
  const gate = require('./lib/open-demo-whatsapp-gate');
  if (!gate.wantsAssignDemoBedConfirmed({})) pass('E1', 'assign flag defaults false');
  else fail('E1', 'assign should default false');

  const ready = gate.evaluateOpenDemoBedAssignmentWriteReady({
    write_status: 'created',
    booking_id: 'x',
    booking_code: 'WH-1',
  });
  if (ready.ok) pass('E2', 'assignment ready when write created');
  else fail('E2', 'assignment should be ready after write');

  const notReady = gate.evaluateOpenDemoBedAssignmentWriteReady({ write_status: 'not_ready' });
  if (!notReady.ok) pass('E3', 'assignment blocked when write not ready');
  else fail('E3', 'assignment should block without write');
} catch (err) {
  fail('E0', `gate smoke threw: ${err.message}`);
}

section('F. Room label fallback (27demo-d.2)');

if (assignSrc.includes('resolveAssignedRoomLabel')) {
  pass('F1', 'assignment module defines room label fallback helper');
} else {
  fail('F1', 'resolveAssignedRoomLabel missing');
}

if (assignSrc.includes('formatAssignmentResponse') && assignSrc.includes('resolveAssignedRoomLabel(base.assigned_bed_label')) {
  pass('F2', 'formatAssignmentResponse applies room label fallback');
} else {
  fail('F2', 'formatAssignmentResponse does not apply fallback');
}

try {
  const { resolveAssignedRoomLabel } = require('./lib/open-demo-booking-bed-assign');
  if (resolveAssignedRoomLabel('DEMO-R1-B1', null) === 'DEMO-R1') {
    pass('F3', 'DEMO-R1-B1 derives DEMO-R1');
  } else {
    fail('F3', 'DEMO-R1-B1 should derive DEMO-R1');
  }
  if (resolveAssignedRoomLabel('DEMO-R2-B2', null) === 'DEMO-R2') {
    pass('F4', 'DEMO-R2-B2 derives DEMO-R2');
  } else {
    fail('F4', 'DEMO-R2-B2 should derive DEMO-R2');
  }
  if (resolveAssignedRoomLabel('DEMO-R1-B1', 'DEMO-R1-KEPT') === 'DEMO-R1-KEPT') {
    pass('F5', 'existing room label preserved when present');
  } else {
    fail('F5', 'existing room label should be preserved');
  }
} catch (err) {
  fail('F0', `room label fallback smoke threw: ${err.message}`);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${passes} passed, ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
