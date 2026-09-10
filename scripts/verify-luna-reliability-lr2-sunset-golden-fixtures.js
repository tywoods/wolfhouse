'use strict';

/**
 * LR2 fixture-pack verifier for Sunset golden ordinary group lessons.
 *
 * Contract: fixtures 03 and 08 are active review-only fixtures shaped like
 * case 09/Seadog LR2: availability read, no retired group quote tool,
 * quote-before-name, create-shaped components.lesson, and central no-send.
 */

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  BLOCK_REASON,
  guardedToolCall,
} = require('./lib/sunset-golden-no-send-guard');

const ROOT = path.join(__dirname, '..');
const FIXTURES_DIR = path.join(ROOT, 'fixtures', 'sunset-golden');
const MANIFEST_PATH = path.join(FIXTURES_DIR, '_manifest.json');

const CASES = [
  {
    file: 'sunset-golden-03-adult-group-lesson-two-whatsapp.json',
    id: 'sunset-golden-03-adult-group-lesson-two-whatsapp',
    quantity: 2,
    serviceDatesCount: 1,
    language: 'en',
  },
  {
    file: 'sunset-golden-08-group-lessons-morning-mon-thu-spanish-whatsapp.json',
    id: 'sunset-golden-08-group-lessons-morning-mon-thu-spanish-whatsapp',
    quantity: 1,
    serviceDatesCount: 4,
    language: 'es',
  },
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function assertCase(c) {
  const fixture = readJson(path.join(FIXTURES_DIR, c.file));
  const exp = fixture.expectations || {};
  const components = exp.after_name_and_confirm_components || {};

  assert.equal(fixture.id, c.id, `${c.file} id`);
  assert.equal(fixture.tenant_id, 'sunset', `${c.file} tenant`);
  assert.equal(fixture.channel, 'whatsapp', `${c.file} channel`);
  assert.equal(fixture.status, 'active', `${c.file} promoted status`);
  assert.equal(fixture.active, true, `${c.file} promoted active flag`);
  assert.notEqual(fixture.allow_writes, true, `${c.file} review-only writes`);
  assert.equal(fixture.whatsapp_suppressed, true, `${c.file} review-only WhatsApp`);

  assert.ok(
    Array.isArray(exp.must_call_tools) && exp.must_call_tools.includes('get_sunset_lesson_availability'),
    `${c.file} requires availability read`,
  );
  assert.ok(
    Array.isArray(exp.must_not_call_tools) && exp.must_not_call_tools.includes('get_sunset_group_lesson_quote'),
    `${c.file} rejects retired quote owner`,
  );
  assert.equal(exp.must_not_ask_booking_name_before_quote, true, `${c.file} quote before name`);
  assert.equal(exp.quote_args && exp.quote_args.location_id, 'sunset-somo', `${c.file} quote location`);
  assert.equal(Number(exp.quote_args && exp.quote_args.quantity), c.quantity, `${c.file} quote quantity`);
  assert.equal(Number(exp.quote_args && exp.quote_args.service_dates_count), c.serviceDatesCount, `${c.file} service dates count`);

  assert.ok(components.lesson, `${c.file} components.lesson exists`);
  assert.equal(Number(components.lesson.quantity), c.quantity, `${c.file} components.lesson quantity means surfers`);
  assert.equal(Object.hasOwn(components, 'group_lesson'), false, `${c.file} no group_lesson component`);
  assert.equal(Object.hasOwn(components, 'course'), false, `${c.file} no invented course`);

  for (const key of exp.forbidden_component_keys || []) {
    assert.equal(Object.hasOwn(components, key), false, `${c.file} forbids ${key}`);
  }

  for (const tool of exp.must_not_call_before_name || []) {
    const out = guardedToolCall(tool, fixture, () => ({ leaked: true }));
    assert.equal(out.blocked, true, `${c.file} ${tool} blocked`);
    assert.equal(out.reason, BLOCK_REASON, `${c.file} ${tool} block reason`);
  }

  console.log(`PASS ${c.file}`);
}

const manifest = readJson(MANIFEST_PATH);
assert.equal(manifest.tenant_id, 'sunset', 'manifest tenant');
assert.equal(manifest.active, true, 'manifest active');
for (const c of CASES) {
  assert.ok(manifest.fixtures.includes(c.file), `${c.file} listed`);
  assertCase(c);
}

console.log('PASS LR2 sunset golden fixtures 03 + 08 active contract');
