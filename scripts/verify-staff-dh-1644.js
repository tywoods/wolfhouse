#!/usr/bin/env node
'use strict';

/**
 * verify:staff-dh-1644
 *
 * Staff-side contract for DH-STAFF-1644 (Ty 16:44 + 16:49 Madrid):
 *   A) One hold; Clear/mark-resolved lifts it; payment-link failure never holds
 *   B) Server cleared_at; Staff loads later messages; Full Wipe impossible on prod
 *   C) Per-guest room_kind private|shared + type, number, supplement
 *   D) Confirmation owed record; clears only on real delivery
 *   E) Prod-vs-TEST env NAMES only (never values)
 *
 * Stay off hermes-luna files. Run: node scripts/verify-staff-dh-1644.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const CONV_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CLIENT = 'wolfhouse-somo';

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return;
  }
  fail += 1;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

function read(rel) {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
  } catch (_) {
    return '';
  }
}

function load(rel) {
  return require(path.join(ROOT, rel));
}

function makeClearPg(seed) {
  const convs = (seed.conversations || []).map((r) => Object.assign({}, r));
  const pauses = (seed.pauses || []).map((r) => Object.assign({}, r));
  const calls = [];
  return {
    convs,
    pauses,
    calls,
    async query(sql, params) {
      const s = String(sql);
      const p = params ? [...params] : [];
      calls.push({ sql: s, params: p });
      if (/\bDELETE\b/i.test(s) && /messages|bookings|payments/i.test(s)) {
        const err = new Error('forbidden_delete');
        err.code = 'FORBIDDEN_DELETE';
        throw err;
      }
      if (/SELECT[\s\S]*FROM conversations conv[\s\S]*JOIN clients/i.test(s)
        && /conv\.id = \$2::uuid/i.test(s)
        && !/regexp_replace/i.test(s)
        && !/\bUPDATE\b/i.test(s)) {
        const row = convs.find((c) => c.id === p[1] && c.client_slug === p[0]);
        const paused = pauses.some((x) => x.paused === true && x.conversation_id === (row && row.id));
        return {
          rows: row ? [Object.assign({
            conversation_id: row.id,
            conversation_paused: paused,
            phone: row.phone,
            metadata: row.metadata || {},
          }, row)] : [],
        };
      }
      if (/regexp_replace/i.test(s) && /SELECT/i.test(s) && !/\bUPDATE\b/i.test(s) && !/bot_pause_states/i.test(s)) {
        return { rows: [] };
      }
      if (/\bUPDATE conversations conv\b/i.test(s) && /needs_human = TRUE/i.test(s)) {
        const row = convs.find((c) => c.id === p[1] && c.client_slug === p[0]);
        if (!row) return { rows: [] };
        row.needs_human = true;
        return {
          rows: [{
            conversation_id: row.id,
            needs_human: true,
            phone: row.phone,
            display_name: row.display_name,
            metadata: row.metadata || {},
          }],
        };
      }
      if (/\bUPDATE conversations conv\b/i.test(s) && /needs_human = FALSE/i.test(s)) {
        const row = convs.find((c) => c.id === p[1] && c.client_slug === p[0]);
        if (!row) return { rows: [] };
        row.needs_human = false;
        row.cleared_at = row.cleared_at || new Date().toISOString();
        if (/cleared_at/i.test(s)) {
          row.cleared_at = new Date().toISOString();
        }
        return {
          rows: [{
            conversation_id: row.id,
            needs_human: false,
            cleared_at: row.cleared_at,
          }],
        };
      }
      if (/FROM bot_pause_states/i.test(s) && /SELECT/i.test(s) && !/\bUPDATE\b/i.test(s)) {
        const active = pauses.filter((x) => x.paused === true && (
          x.conversation_id === (p[1] || p[2]) || x.client_slug === p[0]
        ));
        const hit = active.find((x) => x.conversation_id === CONV_ID) || active[0];
        return { rows: hit ? [hit] : [] };
      }
      if (/\bUPDATE bot_pause_states\b/i.test(s)) {
        const row = pauses.find((x) => x.paused === true);
        if (!row) return { rows: [] };
        row.paused = false;
        row.resumed_at = new Date().toISOString();
        return { rows: [Object.assign({}, row)] };
      }
      if (/INSERT INTO bot_pause_states/i.test(s)) {
        const row = {
          id: 'pause-new',
          client_slug: p[0],
          guest_phone: p[1],
          conversation_id: p[2],
          paused: true,
          pause_reason: p[5],
          paused_by: p[6],
          paused_at: new Date().toISOString(),
        };
        pauses.push(row);
        return { rows: [row] };
      }
      if (/INSERT INTO staff_handoffs/i.test(s)) {
        return { rows: [{ id: 'h1', reason_code: p[3], status: 'open' }] };
      }
      if (/FROM staff_handoffs/i.test(s) && /SELECT/i.test(s)) return { rows: [] };
      if (/\bUPDATE staff_handoffs\b/i.test(s)) {
        return { rows: [{ id: 'h1', status: 'resolved', reason_code: 'human_requested' }] };
      }
      if (/SELECT conv\.phone/i.test(s)) {
        const row = convs[0];
        return { rows: row ? [{ phone: row.phone }] : [] };
      }
      return { rows: [] };
    },
  };
}

async function main() {
  console.log('\nverify:staff-dh-1644 — Staff hold / Clear / rooms / owed / prod fence\n');

  const hold = load('scripts/lib/staff-conversation-hold.js');
  const rooms = load('scripts/lib/staff-guest-room-state.js');
  const owed = load('scripts/lib/staff-booking-confirmation-owed.js');
  const parity = load('scripts/lib/staff-prod-test-env-parity.js');
  const clearOwner = load('scripts/lib/staff-inbox-clear-thread.js');
  const handoff = load('scripts/lib/luna-guest-handoff-persist.js');
  const { getConversationMessagesQuery } = load('scripts/lib/staff-conversation-queries.js');
  const { isProductionStaffRuntime, canInboxFullWipe, canInboxClearThread } = load('scripts/lib/staff-runtime-role.js');

  const persistSrc = read('scripts/lib/luna-guest-handoff-persist.js');
  const clearSrc = read('scripts/lib/staff-inbox-clear-thread.js');
  const apiSrc = read('scripts/staff-query-api.js');
  const threadSrc = read('scripts/browser/inbox-thread.js');
  const msgQuerySrc = read('scripts/lib/staff-conversation-queries.js');
  const mig = read('database/migrations/130_staff_clear_hold_confirmation_owed.sql');
  const pkg = JSON.parse(read('package.json') || '{}');
  const lunaAll = read('scripts/verify-luna-all.js');

  console.log('[0] Owners exist');
  ok('staff-conversation-hold exports payment-link + lift helpers',
    typeof hold.isPaymentLinkFailureReason === 'function'
    && typeof hold.shouldPauseForHandoffReason === 'function');
  ok('staff-runtime-role exports prod/wipe/clear fences',
    typeof isProductionStaffRuntime === 'function'
    && typeof canInboxFullWipe === 'function'
    && typeof canInboxClearThread === 'function');
  ok('staff-guest-room-state exports projector',
    typeof rooms.projectGuestRoomState === 'function'
    && typeof rooms.projectGuestRooms === 'function');
  ok('staff-booking-confirmation-owed exports record/clear',
    typeof owed.recordConfirmationOwed === 'function'
    && typeof owed.clearConfirmationOwedOnDelivery === 'function');
  ok('staff-prod-test-env-parity exports names-only compare',
    typeof parity.compareProdTestEnvNames === 'function');
  ok('migration 130 adds cleared_at + confirmation_owed',
    /cleared_at/i.test(mig)
    && /booking_confirmation_owed/i.test(mig)
    && /clear_reason/i.test(mig));

  console.log('\n[A] Ty 16:49 — Clear lifts needs_human AND hold AND stamps cleared_at');
  ok('Clear owner SQL stamps cleared_at in the same UPDATE as needs_human',
    /needs_human = FALSE/i.test(clearSrc)
    && /cleared_at\s*=\s*NOW\(\)/i.test(clearSrc));
  ok('Clear owner calls resumeConversation in the same reset',
    /resumeConversation/.test(clearSrc)
    && /performInboxClearThreadReset/.test(clearSrc));
  ok('Clear handler response includes hold_lifted + cleared_at + needs_human false',
    /hold_lifted/.test(apiSrc)
    && /cleared_at/.test(apiSrc.slice(apiSrc.indexOf('handleConversationClearThreadSession'), apiSrc.indexOf('handleConversationResetLunaContext'))));
  ok('messages query keeps history and filters created_at > cleared_at',
    /conv\.cleared_at IS NULL OR m\.created_at > conv\.cleared_at/.test(msgQuerySrc)
    && !/DELETE FROM messages/i.test(clearSrc));
  ok('mark-resolved / clearStaffNeedsHuman resumes the hold',
    /resumeConversation/.test(persistSrc.slice(persistSrc.indexOf('async function clearStaffNeedsHuman'))));

  const pgClear = makeClearPg({
    conversations: [{
      id: CONV_ID, client_slug: CLIENT, phone: '+34600000099',
      digits: '34600000099', needs_human: true, display_name: 'Ana', status: 'open',
    }],
    pauses: [{
      id: 'pause-1', client_slug: CLIENT, conversation_id: CONV_ID,
      guest_phone: '+34600000099', paused: true, paused_at: '2026-10-30T00:00:00Z',
    }],
  });
  const cleared = await clearOwner.performInboxClearThreadReset({
    pg: pgClear,
    clientSlug: CLIENT,
    convId: CONV_ID,
    resetHermesConversationSession: async () => ({ ok: true, attempted: true, scope: 'session_key' }),
  });
  ok('Clear same-step result: needs_human gone, hold lifted, cleared_at set, luna_on',
    cleared && cleared.ok === true
    && cleared.needs_human === false
    && cleared.needs_human_cleared === true
    && cleared.hold_lifted === true
    && cleared.luna_on === true
    && cleared.bot_paused === false
    && !!cleared.cleared_at
    && pgClear.convs[0].needs_human === false
    && pgClear.pauses[0].paused === false,
    JSON.stringify({
      ok: cleared && cleared.ok,
      needs_human: cleared && cleared.needs_human,
      hold_lifted: cleared && cleared.hold_lifted,
      luna_on: cleared && cleared.luna_on,
      cleared_at: cleared && cleared.cleared_at,
      conv: pgClear.convs[0].needs_human,
      paused: pgClear.pauses[0].paused,
    }));
  ok('Clear does not delete message history',
    !pgClear.calls.some((c) => /\bDELETE\b/i.test(c.sql) && /messages/i.test(c.sql)));

  const sql = getConversationMessagesQuery();
  ok('getConversationMessagesQuery is a string that filters cleared_at',
    typeof sql === 'string' && /cleared_at/.test(sql) && /m\.created_at > conv\.cleared_at/.test(sql));

  const pgResolved = makeClearPg({
    conversations: [{
      id: CONV_ID, client_slug: CLIENT, phone: '+34600000099',
      needs_human: true, metadata: {}, conversation_paused: true,
    }],
    pauses: [{
      id: 'pause-1', client_slug: CLIENT, conversation_id: CONV_ID,
      paused: true, guest_phone: '+34600000099',
    }],
  });
  const resolved = await handoff.clearStaffNeedsHuman(pgResolved, {
    conversation_id: CONV_ID,
    client_slug: CLIENT,
    resolved_by: 'staff_portal',
    resolution: 'staff_manual_handoff_cleared',
  });
  ok('mark-resolved lifts hold so Luna can reply',
    resolved && resolved.ok === true
    && resolved.needs_human === false
    && resolved.conversation_paused === false
    && resolved.hold_lifted === true
    && pgResolved.pauses[0].paused === false,
    JSON.stringify(resolved));

  console.log('\n[A2] Payment-link failure never holds');
  ok('payment_link_failed is not hold-worthy',
    hold.isPaymentLinkFailureReason('payment_link_failed') === true
    && hold.shouldPauseForHandoffReason('payment_link_failed') === false
    && hold.shouldPauseForHandoffReason('balance_payment_link_failed') === false
    && hold.shouldPauseForHandoffReason('business_tool_error: create_payment_link') === false);
  ok('real handover still holds',
    hold.shouldPauseForHandoffReason('human_requested') === true
    && hold.shouldPauseForHandoffReason('staff_manual_handoff') === true);

  const pgPay = makeClearPg({
    conversations: [{
      id: CONV_ID, client_slug: CLIENT, phone: '+34600000099',
      needs_human: false, metadata: {}, display_name: 'Ana',
    }],
    pauses: [],
  });
  const pay = await handoff.markConversationNeedsHuman(pgPay, {
    conversation_id: CONV_ID,
    client_slug: CLIENT,
    reason: 'payment_link_failed',
  }, { skip_notify: true });
  ok('payment-link flag does not pause and does not set needs_human hold',
    pay && pay.ok === true
    && pay.skipped_hold === true
    && pay.conversation_paused !== true
    && pgPay.pauses.length === 0,
    JSON.stringify(pay));

  const pgHuman = makeClearPg({
    conversations: [{
      id: CONV_ID, client_slug: CLIENT, phone: '+34600000099',
      needs_human: false, metadata: {}, display_name: 'Ana',
    }],
    pauses: [],
  });
  const human = await handoff.markConversationNeedsHuman(pgHuman, {
    conversation_id: CONV_ID,
    client_slug: CLIENT,
    reason: 'human_requested',
  }, { skip_notify: true });
  ok('human_requested still pauses Wolfhouse (the one hold)',
    human && human.ok === true
    && human.needs_human === true
    && human.conversation_paused === true
    && pgHuman.pauses.length >= 1,
    JSON.stringify(human));

  console.log('\n[A3] Staff Luna paused banner + Resume; Clear turns Luna ON');
  ok('existing Luna paused banner stays in thread chrome',
    /Luna paused/.test(threadSrc) && /updateLunaPauseUiInPlace/.test(threadSrc));
  const clearWire = threadSrc.slice(
    threadSrc.indexOf('function wireInboxClearThread'),
    threadSrc.indexOf('function wireAgentSessionReset'),
  );
  ok('Clear success forces per-chat Luna toggle On',
    /forceInboxLunaModeOn\(/.test(clearWire)
    && /luna_paused:\s*false/.test(clearWire));
  ok('Full Wipe button is gated on testing controls',
    /__STAFF_TESTING_CONTROLS__|staffTestingControls/.test(threadSrc)
    && /Full Wipe \(testing\)/.test(threadSrc));
  ok('Clear handler returns luna_on true',
    /luna_on:\s*true/.test(apiSrc.slice(
      apiSrc.indexOf('handleConversationClearThreadSession'),
      apiSrc.indexOf('handleConversationResetLunaContext'),
    )));

  const vm = require('vm');
  const lunaModeSrc = read('scripts/browser/inbox-luna-mode.js');
  function miniBtn(mode, active) {
    const cls = { name: active ? 'inbox-luna-mode-btn is-active' : 'inbox-luna-mode-btn' };
    const node = {
      className: cls.name,
      attrs: { 'data-luna-mode': mode, 'aria-checked': active ? 'true' : 'false' },
      getAttribute(k) { return this.attrs[k]; },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      classList: {
        toggle(name, on) {
          const parts = String(node.className).split(/\s+/).filter(Boolean);
          const i = parts.indexOf(name);
          if (on && i < 0) parts.push(name);
          if (!on && i >= 0) parts.splice(i, 1);
          node.className = parts.join(' ');
        },
      },
    };
    return node;
  }
  const offBtn = miniBtn('off', true);
  const onBtn = miniBtn('auto', false);
  const pauseSw = { checked: true };
  const wrap = {
    getAttribute() { return 'whatsapp'; },
    querySelector(sel) {
      if (sel === '.inbox-luna-mode-label') return { textContent: '' };
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '.inbox-luna-mode-btn') return [onBtn, offBtn];
      return [];
    },
  };
  const sandbox = {
    t: (k) => k,
    escHtml: (s) => String(s == null ? '' : s),
    conversationHasOpenHandoff: () => false,
    document: {
      getElementById() { return null; },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    lunaModeSrc + '\nthis.forceInboxLunaModeOn = forceInboxLunaModeOn;\nthis.syncInboxLunaModeControl = syncInboxLunaModeControl;\n',
    sandbox,
  );
  sandbox.forceInboxLunaModeOn({
    querySelector(sel) {
      if (sel === '.inbox-luna-mode') return wrap;
      if (sel === '#luna-pause-switch') return pauseSw;
      return null;
    },
    querySelectorAll() { return []; },
  });
  ok('forceInboxLunaModeOn unchecks pause switch (Luna On)',
    pauseSw.checked === false);
  ok('forceInboxLunaModeOn marks On active and Off inactive',
    /is-active/.test(onBtn.className)
    && !/is-active/.test(offBtn.className)
    && onBtn.getAttribute('aria-checked') === 'true'
    && offBtn.getAttribute('aria-checked') === 'false',
    JSON.stringify({ on: onBtn.className, off: offBtn.className }));

  console.log('\n[B] Prod is not a test system; Full Wipe blocked; Clear own permission');
  ok('production NODE_ENV is production runtime',
    isProductionStaffRuntime({ NODE_ENV: 'production' }, 'wh.lunafrontdesk.com') === true);
  ok('production STAFF_RUNTIME_PROFILE is production even if NODE_ENV=staging',
    isProductionStaffRuntime({ NODE_ENV: 'staging', STAFF_RUNTIME_PROFILE: 'production' }, 'x') === true);
  ok('LUNA_DEPLOYMENT=production is production',
    isProductionStaffRuntime({ NODE_ENV: 'staging', LUNA_DEPLOYMENT: 'production' }, 'x') === true);
  ok('TEST staging is not production',
    isProductionStaffRuntime({ NODE_ENV: 'staging', STAFF_RUNTIME_PROFILE: 'staging' }, 'staff-staging.lunafrontdesk.com') === false);
  ok('Full Wipe false on production',
    canInboxFullWipe({ NODE_ENV: 'production' }, 'wh.lunafrontdesk.com') === false
    && canInboxFullWipe({ NODE_ENV: 'staging', LUNA_DEPLOYMENT: 'production' }, 'x') === false);
  ok('Full Wipe true on explicit test/staging',
    canInboxFullWipe({ NODE_ENV: 'staging' }, 'staff-staging.lunafrontdesk.com') === true
    && canInboxFullWipe({ NODE_ENV: 'test' }, 'localhost') === true);
  ok('Clear has its own permission (not the wipe fence)',
    canInboxClearThread({ NODE_ENV: 'production' }, 'wh.lunafrontdesk.com') === true
    && canInboxClearThread({ NODE_ENV: 'staging' }, 'staff-staging.lunafrontdesk.com') === true);
  const wipeHandler = apiSrc.slice(
    apiSrc.indexOf('async function handleConversationResetLunaContext'),
    apiSrc.indexOf('async function handleConversationClearMessages'),
  );
  ok('Full Wipe handler uses canInboxFullWipe (never prod)',
    /canInboxFullWipe/.test(wipeHandler));
  const clearHandler = apiSrc.slice(
    apiSrc.indexOf('async function handleConversationClearThreadSession'),
    apiSrc.indexOf('async function handleConversationResetLunaContext'),
  );
  ok('Clear handler uses canInboxClearThread, not the wipe fence',
    /canInboxClearThread/.test(clearHandler)
    && !/canInboxFullWipe/.test(clearHandler));

  console.log('\n[C] Room stated plainly per guest');
  const catalog = {
    R2: { capacity: 5, type: 'male_only' },
    R6: { capacity: 2, type: 'matrimonial_private_couple' },
  };
  const shared = rooms.projectGuestRoomState({
    guest_number: 1,
    guest_name: 'Alex',
    assigned_room_code: 'R2',
  }, catalog, { line_items: [] });
  const priv = rooms.projectGuestRoomState({
    guest_number: 1,
    guest_name: 'Sam',
    assigned_room_code: 'R6',
  }, catalog, { line_items: [{ code: 'room_supplement', total_cents: 7000 }] });
  ok('shared dorm: room_kind=shared + type + number',
    shared.room_kind === 'shared'
    && shared.type === 'male_only'
    && shared.number === 'R2'
    && shared.supplement_cents === 0,
    JSON.stringify(shared));
  ok('private couple: room_kind=private + type + number + supplement',
    priv.room_kind === 'private'
    && priv.type === 'matrimonial_private_couple'
    && priv.number === 'R6'
    && priv.supplement_cents === 7000,
    JSON.stringify(priv));
  ok('room_kind is only private|shared',
    rooms.ROOM_KINDS.has('private') && rooms.ROOM_KINDS.has('shared') && rooms.ROOM_KINDS.size === 2);
  ok('Staff booking create/get project guest_rooms',
    /guest_rooms/.test(apiSrc)
    && /projectGuestRooms/.test(apiSrc));

  console.log('\n[D] Confirmation owed clears only on real delivery');
  const owedCalls = [];
  const pgOwed = {
    async query(sql, params) {
      owedCalls.push({ sql: String(sql), params: params ? [...params] : [] });
      if (/INSERT INTO booking_confirmation_owed/i.test(sql)) {
        return { rows: [{ booking_id: params[0], owed_at: new Date().toISOString(), cleared_at: null }] };
      }
      if (/UPDATE booking_confirmation_owed/i.test(sql)) {
        const providerId = params[params.length - 1] || params[2];
        if (!providerId) return { rows: [] };
        return { rows: [{ booking_id: params[0], cleared_at: new Date().toISOString(), clear_reason: 'delivered' }] };
      }
      return { rows: [] };
    },
  };
  const recorded = await owed.recordConfirmationOwed(pgOwed, {
    booking_id: '11111111-1111-4111-8111-111111111111',
    client_id: '22222222-2222-4222-8222-222222222222',
  });
  ok('saving a booking records confirmation owed',
    recorded && recorded.ok === true && recorded.owed === true, JSON.stringify(recorded));
  const dry = await owed.clearConfirmationOwedOnDelivery(pgOwed, {
    booking_id: '11111111-1111-4111-8111-111111111111',
    provider_message_id: '',
  });
  ok('dry-run / no provider id does not clear owed',
    dry && dry.ok === true && dry.cleared !== true, JSON.stringify(dry));
  const delivered = await owed.clearConfirmationOwedOnDelivery(pgOwed, {
    booking_id: '11111111-1111-4111-8111-111111111111',
    provider_message_id: 'wamid.ABC',
  });
  ok('real delivery with provider id clears owed',
    delivered && delivered.ok === true && delivered.cleared === true, JSON.stringify(delivered));
  ok('markBookingConfirmationSent calls clear on delivery',
    /clearConfirmationOwedOnDelivery/.test(read('scripts/lib/luna-booking-confirmation-send.js')));
  ok('booking create records confirmation owed',
    /recordConfirmationOwed/.test(read('scripts/lib/luna-front-desk-accommodation-booking-create-service.js')));

  console.log('\n[E] Prod-vs-TEST parity — names only, never values');
  const compared = parity.compareProdTestEnvNames({ root: ROOT });
  ok('compare returns name lists only',
    compared && Array.isArray(compared.test_names) && Array.isArray(compared.prod_declared_names)
    && Array.isArray(compared.missing_on_prod)
    && !Object.prototype.hasOwnProperty.call(compared, 'values')
    && compared.test_names.every((n) => typeof n === 'string' && !/=/.test(n)));
  ok('missing list includes STRIPE_WEBHOOK_SECRET and STRIPE_WEBHOOK_CLIENT_SLUG',
    compared.missing_on_prod.indexOf('STRIPE_WEBHOOK_SECRET') >= 0
    && compared.missing_on_prod.indexOf('STRIPE_WEBHOOK_CLIENT_SLUG') >= 0,
    JSON.stringify(compared.missing_on_prod));
  ok('parity helper never reads live env files under /etc',
    !/\/etc\/wolfhouse-prod/.test(read('scripts/lib/staff-prod-test-env-parity.js'))
    || /do not read live/i.test(read('scripts/lib/staff-prod-test-env-parity.js')));
  ok('source files contain no secret assignment dumps in the parity module',
    !/sk_live_|whsec_[A-Za-z0-9]{8,}/.test(read('scripts/lib/staff-prod-test-env-parity.js')));

  console.log('\n[F] Wired into package.json + luna-all');
  ok('package.json registers verify:staff-dh-1644',
    pkg.scripts && pkg.scripts['verify:staff-dh-1644'] === 'node scripts/verify-staff-dh-1644.js');
  ok('verify-luna-all includes staff-dh-1644',
    /verify-staff-dh-1644\.js/.test(lunaAll));

  if (fail) {
    console.error(`\nverify:staff-dh-1644 — FAILED (${pass} pass, ${fail} fail)`);
    process.exit(1);
  }
  console.log(`\nverify:staff-dh-1644 — ALL CHECKS PASSED (${pass})`);
}

main().catch((err) => {
  console.error('verify:staff-dh-1644 — ERROR', err);
  process.exit(1);
});
