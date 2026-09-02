#!/usr/bin/env node
'use strict';

/**
 * verify-sunset-luna-needs-human-send-fix
 *
 * Pins fixes for Sunset staging Luna:
 *   A) lesson-availability compares party quantity to remaining seats (insufficient_seats)
 *   B) outbound Inbox mirror only after Meta wamid; no fake sent bubble without wamid
 *
 * Offline only. Run: node scripts/verify-sunset-luna-needs-human-send-fix.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STAFF_API = path.join(ROOT, 'scripts/staff-query-api.js');
const THREAD_MSG = path.join(ROOT, 'scripts/lib/luna-staff-inbox-thread-message.js');
const MIRROR_PY = path.join(ROOT, 'docker/hermes-staging/wolfhouse_whatsapp_mirror.py');
const PATCH_PY = path.join(ROOT, 'docker/hermes-staging/apply_gateway_patches.py');
const PLUGIN = path.join(ROOT, 'docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py');

let pass = 0;
let fail = 0;

function ok(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    fail += 1;
  }
}

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

console.log('\nverify-sunset-luna-needs-human-send-fix\n');

console.log('[A] Lesson availability — party quantity vs remaining seats');
const apiSrc = read(STAFF_API);
ok('handler accepts body.quantity', /requestedQtyRaw\s*=\s*body\.quantity/.test(apiSrc));
ok('insufficient_seats reason when some seats remain', /insufficient_seats/.test(apiSrc));
ok('requested_quantity in response', /requested_quantity:\s*requestedQuantity/.test(apiSrc));
ok('timed path uses resolveCourseScopedLessonAvailability', /resolveCourseScopedLessonAvailability/.test(apiSrc));

const pluginSrc = read(PLUGIN);
ok('plugin forwards quantity to Staff API', /body\["quantity"\]\s*=\s*qty/.test(pluginSrc));
ok('plugin surfaces requested_quantity', /"requested_quantity":\s*data\.get\("requested_quantity"\)/.test(pluginSrc));
ok('tool schema documents quantity', /"quantity":\s*\{"type":\s*"integer"/.test(pluginSrc));
ok('plugin forwards slot_time for timed leftover', /body\["slot_time"\]\s*=\s*slot/.test(pluginSrc));

console.log('\n[B] Persist vs send — wamid required; post-send mirror only');
const threadSrc = read(THREAD_MSG);
ok('persistHermes outbound requires wamid', /missing_whatsapp_message_id/.test(threadSrc));

const patchSrc = read(PATCH_PY);
ok('no pre-send outbound mirror in turn handler', !/OUTBOUND_MIRROR\s*=/.test(patchSrc));
ok('post-send mirror hook in send patch', /mirror_whatsapp_outbound_after_send/.test(patchSrc));
ok('suppresses mirror on suppressed_* send', /suppressed_/.test(patchSrc));

const mirrorSrc = read(MIRROR_PY);
ok('mirror_whatsapp_outbound_after_send exported', /def mirror_whatsapp_outbound_after_send/.test(mirrorSrc));
ok('handoff promise only when wamid present', /direction == "outbound" and wa_id and detects_handoff_promise/.test(mirrorSrc));
ok('take_request safe harbor in mirror', /def is_sunset_take_request_queue_reply/.test(mirrorSrc));
ok('human reassurance safe harbor in mirror', /def is_sunset_human_reassurance_reply/.test(mirrorSrc));
ok('combined sunset suppression in mirror', /def _sunset_handoff_promise_suppressed/.test(mirrorSrc));

console.log('\n[C] take_request queue — not a needs_human handoff');
const { detectHandoffPromise } = require('./lib/luna-guest-handoff-promise');
const hernanTakeRequest =
  "I've passed your request to the team — nothing is booked yet. We'll confirm the exact lesson time.";
const hernan15 =
  'For 15 surfers at 10:00 tomorrow this needs the team to confirm the exact time rather than being booked instantly.';
ok('passed-request take_request copy suppressed', detectHandoffPromise(hernanTakeRequest).handoff_promised !== true);
ok('insufficient-seats confirm-time copy suppressed', detectHandoffPromise(hernan15).handoff_promised !== true);
ok('real handoff still detected', detectHandoffPromise('A teammate will take over and sort those for you.').handoff_promised === true);
ok('sunset human reassurance paraphrase suppressed', detectHandoffPromise(
  "I've looped in a human from the Sunset team to confirm your lesson time.",
).handoff_promised !== true);
ok('sunset follow-up confirm suppressed', detectHandoffPromise(
  'someone from the Sunset team will follow up in the chat to confirm your slot',
).handoff_promised !== true);

console.log('\n[E] Sunset SOUL — clarify first, unclear ≠ needs_human');
const soulSrc = read(path.join(ROOT, 'docker/hermes-sunset/SOUL.md'));
ok('SOUL forbids handoff on vague/unclear intake', /Unclear request — clarify first \(hard\)/.test(soulSrc));
ok('SOUL lists ambiguous fields to clarify', /lesson vs rental/.test(soulSrc) && /party size/.test(soulSrc));
ok('SOUL says unclear ≠ staff review', /Unclear ≠ staff review/.test(soulSrc));
ok('SOUL removed handoff-on-unclear shortcut', !/let me get the team to confirm that for you/i.test(soulSrc));

console.log('\n[D] In-memory mirror contract');
const {
  persistHermesLunaOutboundThreadMessage,
  HERMES_LUNA_OUTBOUND_SOURCE,
} = require('./lib/luna-staff-inbox-thread-message');

(async () => {
  const pg = {
    async query(sql, params) {
      const s = String(sql);
      if (/SELECT conv\.id, conv\.client_id/.test(s)) {
        return { rows: [{ id: 'conv-1', client_id: 'client-sunset' }] };
      }
      if (/FROM messages m/.test(s)) return { rows: [] };
      if (/INSERT INTO messages/.test(s)) {
        return {
          rows: [{
            message_id: 'msg-1',
            whatsapp_message_id: params[4],
            source: params[3],
            direction: 'outbound',
          }],
        };
      }
      return { rows: [] };
    },
  };

  const noWamid = await persistHermesLunaOutboundThreadMessage(pg, {
    client_slug: 'sunset',
    conversation_id: 'conv-1',
    message_text: 'Looks sent but is not',
  }, { idempotency_key: 'idem-no-wamid' });
  ok('outbound without wamid not persisted', noWamid.persisted !== true && noWamid.reason === 'missing_whatsapp_message_id');

  const withWamid = await persistHermesLunaOutboundThreadMessage(pg, {
    client_slug: 'sunset',
    conversation_id: 'conv-1',
    message_text: 'Delivered reply',
    whatsapp_message_id: 'wamid.DELIVERED1',
  });
  ok('outbound with wamid persisted', withWamid.persisted === true && withWamid.source === HERMES_LUNA_OUTBOUND_SOURCE);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
