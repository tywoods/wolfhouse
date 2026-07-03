'use strict';

/**
 * verify:sunset-private-lesson-luna-contract
 *
 * Staff API + Luna contract for Sunset private lessons (no WhatsApp, no deploy).
 * Run: node scripts/verify-sunset-private-lesson-luna-contract.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0;
let fail = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    fail += 1;
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

console.log('\nverify:sunset-private-lesson-luna-contract — Luna/Staff private lesson contract\n');

const catalogMod = read('scripts/lib/sunset-private-lesson-luna-catalog.js');
const tenantCfg = read('scripts/lib/tenant-business-config.js');
const catalogTool = read('scripts/lib/sunset-catalog-tool-executor.js');
const agentExec = read('scripts/lib/luna-guest-agent-tool-executor.js');
const explainer = read('scripts/lib/luna-guest-service-transfer-explainer.js');
const sunsetTurn = read('scripts/lib/luna-guest-sunset-school-turn.js');

assert('catalog module requires_custom_sessions', catalogMod.includes('requires_custom_sessions: true'));
assert('catalog module empty slots', catalogMod.includes('schedule_slots: []'));
assert('catalog module session_count field', catalogMod.includes("quantity_field: 'session_count'"));
assert('catalog module no package tiers', /package_tiers:\s*\[\]/.test(catalogMod));
assert('catalog module no discounts', /discounts:\s*\[\]/.test(catalogMod));
assert('catalog maps legacy private_coaching', catalogMod.includes('private_coaching'));
assert('tenant config attachSunsetCatalogServices', tenantCfg.includes('attachSunsetCatalogServices'));
assert('catalog tool get_sunset_private_lesson', catalogTool.includes('get_sunset_private_lesson'));
assert('agent snapshot exposes private_lesson_catalog', agentExec.includes('private_lesson_catalog'));
assert('agent snapshot exposes catalog_services', agentExec.includes('catalog_services'));
assert('explainer session count detector', explainer.includes('detectPrivateLessonSessionCount'));
assert('explainer session times reply', explainer.includes('buildPrivateLessonSessionTimesReply'));
assert('sunset turn uses private lesson catalog tool', sunsetTurn.includes("get_sunset_private_lesson"));

const {
  buildPrivateLessonCatalogItem,
  attachSunsetCatalogServices,
  normalizeLunaPrivateLessonBookingPayload,
} = require('./lib/sunset-private-lesson-luna-catalog');
const { executeSunsetCatalogTool } = require('./lib/sunset-catalog-tool-executor');
const { resolveTenantBusinessConfig } = require('./lib/tenant-business-config');
const {
  detectPrivateLessonSessionCount,
  buildPrivateLessonSessionTimesReply,
  buildServiceSideQuestionReply,
} = require('./lib/luna-guest-service-transfer-explainer');

const item = buildPrivateLessonCatalogItem({
  enabled: true,
  label: 'Private lesson',
  amount_cents: 6000,
  currency: 'EUR',
  price_basis: 'per_session',
  default_duration_minutes: 120,
});
assert('catalog item service_key private_lesson', item.service_key === 'private_lesson');
assert('catalog item requires custom sessions', item.requires_custom_sessions === true);
assert('catalog item no slots', Array.isArray(item.slots) && item.slots.length === 0);
assert('catalog item no tiers', item.package_tiers.length === 0 && item.discounts.length === 0);

const attached = attachSunsetCatalogServices({
  private_lesson: { enabled: true, label: 'Private lesson', amount_cents: 6000, currency: 'EUR', default_duration_minutes: 120 },
});
assert('attached catalog_services length 1 when enabled', attached.catalog_services.length === 1);
assert('attached private_lesson_catalog present', attached.private_lesson_catalog.service_key === 'private_lesson');

const sunsetCfg = resolveTenantBusinessConfig('sunset', 'sunset-somo');
assert('resolveTenantBusinessConfig exposes catalog_services', Array.isArray(sunsetCfg.catalog_services));
assert('resolveTenantBusinessConfig exposes private_lesson_catalog', sunsetCfg.private_lesson_catalog != null);

const toolOut = executeSunsetCatalogTool('get_sunset_private_lesson', {
  client_slug: 'sunset',
  location_id: 'sunset-somo',
  dry_run: true,
  args: {},
});
assert('catalog tool disabled by default config', toolOut.ok === false && toolOut.reason === 'private_lesson_disabled');

const booking = normalizeLunaPrivateLessonBookingPayload({
  guest_name: 'Test Guest',
  date_from: '2026-07-10',
  date_to: '2026-07-12',
  private_lesson: {
    enabled: true,
    session_count: 3,
    surfer_count: 1,
    sessions: [
      { date: '2026-07-10', start: '10:00', end: '12:00' },
      { date: '2026-07-11', start: '14:00', end: '16:00' },
      { date: '2026-07-12', start: '09:30', end: '11:30' },
    ],
  },
});
assert('booking payload 3 sessions validates', booking.ok === true);
assert('booking normalized session count 3', booking.value.components.private_lesson.quantity === 3);

const badBooking = normalizeLunaPrivateLessonBookingPayload({
  guest_name: 'Test Guest',
  date_from: '2026-07-10',
  date_to: '2026-07-10',
  private_lesson: {
    enabled: true,
    session_count: 2,
    sessions: [{ date: '2026-07-10', start: '10:00', end: '12:00' }],
  },
});
assert('booking rejects session_count mismatch', badBooking.ok === false);

assert('detect 3 private lessons', detectPrivateLessonSessionCount('I want 3 private lessons') === 3);
const reply = buildServiceSideQuestionReply('en', 'surf_lessons', 'I want 3 private lessons', { default_duration_minutes: 120 });
assert('reply asks for session times', /date and start time/i.test(reply));
assert('reply no package wording', !/package|discount|€35|tier/i.test(reply));
const clarify = buildPrivateLessonSessionTimesReply('en', 3, 120);
assert('session times reply one question', (clarify.match(/\?/g) || []).length >= 1);

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:sunset-private-lesson-luna-contract — FAILED');
  process.exit(1);
}
console.log('verify:sunset-private-lesson-luna-contract — ALL CHECKS PASSED');
