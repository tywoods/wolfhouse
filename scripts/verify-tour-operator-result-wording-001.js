#!/usr/bin/env node
'use strict';

/**
 * Tour Operator result wording — Wolfhouse Staff display only.
 * The page calls this for wolfhouse-somo. Sunset keeps the old strings.
 * No API or write-rule changes.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const WORDING = path.join(ROOT, 'scripts/browser/tour-operator-result-wording.js');
const API = path.join(ROOT, 'scripts/staff-query-api.js');

assert.ok(fs.existsSync(WORDING), 'wording module exists');
const src = fs.readFileSync(WORDING, 'utf8');
const apiSrc = fs.readFileSync(API, 'utf8');

const sandbox = { module: { exports: {} }, exports: {} };
vm.runInNewContext(src, sandbox);
const plain = sandbox.module.exports.tourOperatorPlainResult;
assert.equal(typeof plain, 'function', 'exports tourOperatorPlainResult');

function joined(result) {
  return [result.badge].concat(result.lines || []).join('\n');
}

const blocked = plain({
  action: 'release',
  error: 'release_blocked',
  actionable: ['postgres_overlap_conflicts_in_release_window', 'booking_id_mismatch'],
  context: { roomCode: '12', releaseStart: '2026-10-12', releaseEnd: '2026-10-14', bookingCode: 'OP-1' },
});
assert.equal(blocked.kind, 'blocked', 'release_blocked is blocked');
assert.equal(blocked.badge, 'Blocked');
assert.ok(!/release_blocked/.test(joined(blocked)), 'raw release_blocked is not shown');
assert.ok(/guest bookings already use those dates/i.test(joined(blocked)), 'overlap is plain');
assert.ok(/Room 12/.test(joined(blocked)) && /2026-10-12/.test(joined(blocked)) && /OP-1/.test(joined(blocked)), 'room date booking stay visible');
assert.equal(blocked.holdRetry, false, 'a definite block is not an uncertain retry');

const conflicts = plain({
  action: 'create',
  error: 'bed_conflicts',
  conflicts: [{ bed_code: '12A', booking_code: 'BK-9' }],
  context: { roomCode: '12', checkIn: '2026-11-01', checkOut: '2026-11-04', operatorName: 'Sol Tour' },
});
assert.equal(conflicts.kind, 'blocked');
assert.ok(/12A/.test(joined(conflicts)) && /BK-9/.test(joined(conflicts)), 'conflict keeps bed and booking');
assert.ok(/Room 12/.test(joined(conflicts)) && /Sol Tour/.test(joined(conflicts)));
assert.ok(!/bed_conflicts/.test(joined(conflicts)));

const previewConflict = plain({
  action: 'preview',
  ok: true,
  canCreate: false,
  conflicts: [{ bed_code: '3B', booking_code: 'BK-3' }],
  context: { roomCode: '3', checkIn: '2026-07-01', checkOut: '2026-07-03' },
});
assert.equal(previewConflict.kind, 'blocked', 'preview conflict is blocked, not a vague failure');
assert.ok(/3B/.test(joined(previewConflict)) && /BK-3/.test(joined(previewConflict)));

const created = plain({
  action: 'create',
  ok: true,
  booking: { booking_code: 'OP-NEW', room_code: '3', check_in: '2026-12-01', check_out: '2026-12-05' },
});
assert.equal(created.kind, 'completed');
assert.equal(created.badge, 'Completed');
assert.ok(/OP-NEW/.test(joined(created)) && /Room 3/.test(joined(created)));
assert.ok(!/not changed/i.test(joined(created)));

const released = plain({
  action: 'release',
  ok: true,
  release: { block_a: { booking_code: 'OP-1-A' }, block_b: { booking_code: 'OP-1-B' } },
  context: { roomCode: '4', releaseStart: '2026-10-02', releaseEnd: '2026-10-04', bookingCode: 'OP-1' },
});
assert.equal(released.kind, 'completed');
assert.ok(/OP-1-A/.test(joined(released)) && /OP-1-B/.test(joined(released)));

const lost = plain({
  action: 'release',
  lost: true,
  context: { roomCode: '8', releaseStart: '2026-09-01', releaseEnd: '2026-09-03', bookingCode: 'OP-8' },
});
assert.equal(lost.kind, 'uncertain');
assert.equal(lost.holdRetry, true);
assert.ok(lost.lines.indexOf('Outcome uncertain, refresh blocks before retrying') === 0);
assert.ok(!/not changed/i.test(joined(lost)), 'lost response never claims not changed');
assert.ok(!/\bError\b/.test(joined(lost)) && !/release_blocked/.test(joined(lost)));
assert.ok(/Room 8/.test(joined(lost)) && /OP-8/.test(joined(lost)));

const failed = plain({ action: 'create', error: 'create failed', context: { roomCode: '2', checkIn: '2026-08-01', checkOut: '2026-08-03' } });
assert.equal(failed.kind, 'failed');
assert.equal(failed.badge, 'Failed');
assert.notEqual(failed.kind, 'blocked');
assert.notEqual(failed.kind, 'completed');
assert.ok(!/create failed/.test(joined(failed)));

const stuck = plain({ action: 'release', error: 'request_stuck_processing', context: { bookingCode: 'OP-2' } });
assert.equal(stuck.kind, 'blocked');
assert.ok(/still processing/i.test(joined(stuck)));
assert.ok(!/request_stuck_processing/.test(joined(stuck)));
assert.equal(stuck.holdRetry, true, 'stuck processing waits for a refresh');

assert.ok(!/not changed/i.test(src), 'wording module never says not changed');
assert.ok(apiSrc.includes("error: 'release_blocked'"), 'API still returns release_blocked');
assert.ok(apiSrc.includes('bk-preview-badge">Error</div>'), 'Sunset error badge string remains');
assert.ok(/toGetClient\(\) === 'wolfhouse-somo'/.test(apiSrc), 'plain wording is wolfhouse-somo only');
assert.ok(apiSrc.includes('tourOperatorPlainResult'), 'page calls the wording helper');
assert.ok(apiSrc.includes('/* INJECT:tour-operator-result-wording */'), 'wording is injected');
assert.ok(apiSrc.includes("readFileSync(path.join(__dirname, 'browser', 'tour-operator-result-wording.js')"), 'injector reads the wording file');
assert.ok(!/function handleTourOperatorRelease[\s\S]{0,400}tourOperatorPlainResult/.test(apiSrc), 'release handler is not the display helper');

console.log('PASS tour-operator-result-wording-001 wolfhouse plain results + uncertain retry');
