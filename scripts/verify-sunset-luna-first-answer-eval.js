#!/usr/bin/env node
'use strict';

/**
 * verify-sunset-luna-first-answer-eval
 *
 * Ty 2026-09-02 first-answer eval pack (Sunset staging only).
 * Grades Luna's FIRST Staff lookup/result + FIRST reply text against
 * Horario / Staff API for open seats, kids/group party, gear inclusions,
 * and location — never recovery after guest pushback.
 *
 * Offline only. No live WhatsApp. No invented prices. Failures → pack cases.
 *
 * Run: node scripts/verify-sunset-luna-first-answer-eval.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'sunset-first-answer');

let pass = 0;
let fail = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
    return;
  }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
}

function run(cmd, args) {
  const out = execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout: 90000 });
  process.stdout.write(out.split('\n').map((l) => (l ? `       ${l}` : l)).join('\n'));
  if (!out.endsWith('\n')) process.stdout.write('\n');
  return out;
}

console.log('\nverify-sunset-luna-first-answer-eval\n');

console.log('[0] Fixture pack surface (EN/ES + fail-closed)');
const manifestPath = path.join(FIXTURE_DIR, '_manifest.json');
assert('manifest exists', fs.existsSync(manifestPath));
let manifest = { cases: [] };
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (err) {
  assert('manifest parses', false, String(err.message || err));
}
const caseFiles = Array.isArray(manifest.cases) ? manifest.cases : [];
assert('at least 10 reply cases', caseFiles.length >= 10, `count=${caseFiles.length}`);
const loaded = [];
for (const name of caseFiles) {
  const p = path.join(FIXTURE_DIR, name);
  assert(`case file ${name}`, fs.existsSync(p));
  if (fs.existsSync(p)) {
    loaded.push(JSON.parse(fs.readFileSync(p, 'utf8')));
  }
}
const langs = new Set(loaded.map((c) => c.lang).filter(Boolean));
assert('EN cases present', langs.has('en'), [...langs].join(','));
assert('ES cases present', langs.has('es'), [...langs].join(','));
const kinds = new Set(loaded.map((c) => c.kind).filter(Boolean));
assert('unscoped_party kind', kinds.has('unscoped_party'));
assert('timed_leftover kind', kinds.has('timed_leftover'));
assert('gear_included kind', kinds.has('gear_included'));
assert('fail_closed_wrong_reply kind', kinds.has('fail_closed_wrong_reply'));
assert(
  'has expect_pass=false fail-closed cases',
  loaded.some((c) => c.expect_pass === false && c.kind === 'fail_closed_wrong_reply'),
);
assert(
  'timed fixture open spots = course capacity − booked',
  loaded.some(
    (c) => c.id === 'timed-leftover-en-open-spots'
      && c.guest
      && c.guest.date === '2026-09-25'
      && c.guest.slot_time === '12:00'
      && c.staff
      && c.staff.seats_available === 11
      && c.staff.seats_booked === 13
      && c.staff.course_capacity === 24
      && c.staff.seats_available === c.staff.course_capacity - c.staff.seats_booked,
  ),
);
assert(
  'pack stays off luna_http_server / inbox-thread / Meta',
  !/luna_http_server|inbox-thread|graph\.facebook|n8n/.test(
    fs.readFileSync(manifestPath, 'utf8') + loaded.map((c) => JSON.stringify(c)).join(''),
  ),
);

console.log('\n[1] Python first-answer eval pack');
try {
  const out = run('python3', [
    'docker/hermes-staging/plugins/wolfhouse_staff_api/test_sunset_first_answer_eval.py',
  ]);
  assert(
    'first-answer python green',
    /\b0 failed\b/.test(out) && !/\bFAIL\s{2}/.test(out),
  );
  assert(
    'kids-vs-adult skip noted when Staff board has no field',
    /SKIP[\s\S]*kids-vs-adult|structured Staff audience field present/.test(out),
  );
  assert(
    'reply fixture fail-closed exercised',
    /fail-closed-wrong-first-reply|pack fails closed on deliberately wrong/.test(out),
  );
  assert(
    'EN/ES reply cases scored',
    /unscoped-party-en-ask-time/.test(out) && /unscoped-party-es-ask-time/.test(out),
  );
} catch (err) {
  assert('first-answer python green', false, String((err && err.stdout) || err.message).slice(0, 800));
}

console.log('\n[2] Course-slot leftover gate (Thu 10:00 / 3 of 25 / qty 14)');
try {
  const out = run('node', ['scripts/verify-sunset-lesson-availability-course-slot.js']);
  assert('course-slot leftover green', /passed, 0 failed/.test(out) || /\b0 failed\b/.test(out));
  assert('open spots math 25-3=22 still asserted', /seats_available is Horario remaining 22/.test(out));
} catch (err) {
  assert('course-slot leftover green', false, String((err && err.stdout) || err.message).slice(0, 500));
}

console.log('\n[3] Party-capacity / unscoped first-pass (#844 ownership preserved)');
try {
  const out = run('python3', [
    'docker/hermes-staging/plugins/wolfhouse_staff_api/test_sunset_party_capacity.py',
  ]);
  assert('party capacity green', /\b0 failed\b/.test(out) && !/\bFAIL\s{2}/.test(out));
  assert('unscoped first-pass still present', /Unspecified time|course_choices|joinable-course/.test(out));
  assert('EN/ES shortfall copy still bilingual-tolerant', /otra|otro|another|other|different/.test(out));
} catch (err) {
  assert('party capacity green', false, String((err && err.stdout) || err.message).slice(0, 500));
}

console.log('\n[4] Static wiring — first answer cannot skip to daily invent');
const pluginSrc = fs.readFileSync(
  path.join(ROOT, 'docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py'),
  'utf8',
);
const availFnStart = pluginSrc.indexOf('def get_sunset_lesson_availability');
const availFnEnd = pluginSrc.indexOf('\ndef get_sunset_joinable_courses', availFnStart);
const availFn = availFnStart >= 0 && availFnEnd > availFnStart
  ? pluginSrc.slice(availFnStart, availFnEnd)
  : '';
assert('availability fn extracted', availFn.length > 200);
assert(
  'unscoped path short-circuits to joinable-courses',
  /if not slot and not course_id:/.test(availFn)
    && /\/sunset\/joinable-courses/.test(availFn)
    && availFn.indexOf('/sunset/joinable-courses') < availFn.indexOf('/sunset/lesson-availability'),
);
assert('has_fitting_course annotated on first pass', /has_fitting_course/.test(availFn));
assert('do_not_claim_date_full annotated on first pass', /do_not_claim_date_full/.test(availFn));
assert(
  'tool description grades FIRST result / forbids daily invent',
  /Grade the FIRST result/.test(pluginSrc) && /has_fitting_course/.test(pluginSrc),
);

const soul = fs.readFileSync(path.join(ROOT, 'docker/hermes-sunset/SOUL.md'), 'utf8');
assert('SOUL grades FIRST answer from tool result', /FIRST answer/.test(soul));
assert('SOUL forbids inventing kids\/gear\/school leftover', /Kids \/ age \/ school facts/.test(soul));
assert('SOUL keeps has_fitting_course / do_not_claim_date_full guidance', /has_fitting_course|do_not_claim_date_full/.test(soul));

const libSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-lesson-availability.js'), 'utf8');
assert('Staff timed leftover uses course remaining not daily_cap', /never daily_cap/.test(libSrc) || /seats_available is course remaining/.test(libSrc));

assert(
  'eval pack stays off inbox-thread.js',
  !fs.existsSync(path.join(ROOT, 'scripts/browser/inbox-thread.js'))
    || !/inbox-thread/.test(fs.readFileSync(path.join(ROOT, 'docker/hermes-staging/plugins/wolfhouse_staff_api/test_sunset_first_answer_eval.py'), 'utf8')),
);
assert(
  'eval pack stays off luna_http_server.py (tests/fixtures only grow)',
  !fs.existsSync(path.join(ROOT, 'docker/hermes-staging/wolfhouse/luna_http_server.py'))
    || (() => {
      // Mentioning the forbidden path in a "stays off" assertion is OK;
      // importing / calling the HTTP runtime from the pack is not.
      const src = fs.readFileSync(
        path.join(ROOT, 'docker/hermes-staging/plugins/wolfhouse_staff_api/test_sunset_first_answer_eval.py'),
        'utf8',
      );
      return !/import\s+.*luna_http_server|from\s+wolfhouse\.luna_http_server|handle_inbound_request/.test(src);
    })(),
);

console.log(`\nverify-sunset-luna-first-answer-eval: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
