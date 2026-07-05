'use strict';

/**
 * Verifier for gated manual live WhatsApp delivery (no DB network, no real sends).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const libPath = path.join(ROOT, 'scripts', 'lib', 'staff-automated-notifications.js');
const runnerPath = path.join(ROOT, 'scripts', 'run-staff-automated-notifications.js');

const {
  buildStaffAutomatedNotificationDedupeKey,
  getAutomationLocalParts,
  checkStaffAutomatedNotificationsLiveGates,
  buildStaffAutomatedNotificationLiveMessage,
  runDueStaffAutomatedNotificationsLive,
  parseStaffAutomatedNotificationsAllowedPhones,
} = require('./lib/staff-automated-notifications');

let pass = 0;
let fail = 0;

function ok(name, cond) {
  if (cond) {
    pass += 1;
    console.log('  PASS ', name);
  } else {
    fail += 1;
    console.log('  FAIL ', name);
  }
}

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function createMockPg(seed = {}) {
  const automations = (seed.automations || []).map((row) => ({ ...row }));
  const events = [];
  const eventKeys = new Set();

  return {
    automations,
    events,
    async query(sql, params = []) {
      const q = String(sql);
      if (/CREATE TABLE/i.test(q) || /CREATE UNIQUE INDEX/i.test(q) || /CREATE INDEX/i.test(q)) {
        return { rows: [], rowCount: 0 };
      }
      if (/FROM staff_automated_notifications/i.test(q) && /SELECT/i.test(q)) {
        let rows = automations.filter((a) => a.enabled === true);
        const slug = params[0];
        if (params.length >= 1 && /client_slug = \$1/.test(q)) {
          rows = rows.filter((a) => a.client_slug === slug);
        }
        if (/COALESCE\(location_id/.test(q) && params.length >= 2) {
          const loc = params[1] || '';
          rows = rows.filter((a) => (a.location_id || '') === (loc || ''));
        }
        return { rows };
      }
      if (/FROM staff_automated_notification_events/i.test(q) && /SELECT/i.test(q) && /dedupe_key/i.test(q)) {
        const dedupeKey = params[0];
        const rows = events
          .filter((evt) => evt.dedupe_key === dedupeKey)
          .map((evt) => ({ recipient_phone: evt.recipient_phone, status: evt.status }));
        return { rows };
      }
      if (/INSERT INTO staff_automated_notification_events/i.test(q)) {
        const key = `${params[5]}::${params[6]}`;
        if (eventKeys.has(key)) {
          const err = new Error('duplicate');
          err.code = '23505';
          throw err;
        }
        eventKeys.add(key);
        const row = {
          id: `evt-${events.length + 1}`,
          automation_id: params[0],
          client_slug: params[1],
          location_id: params[2],
          due_local_date: params[3],
          due_local_time: params[4],
          dedupe_key: params[5],
          recipient_phone: params[6],
          recipient_name: params[7],
          status: params[8],
          question: params[9],
          answer_preview: params[10],
          error: params[11],
        };
        events.push(row);
        return { rows: [{ id: row.id, status: row.status }] };
      }
      if (/UPDATE staff_automated_notifications/i.test(q) && /last_run_at/i.test(q)) {
        const id = params[0];
        const auto = automations.find((a) => String(a.id) === String(id));
        if (auto) {
          auto.last_run_at = params[1];
          auto.last_status = params[2];
          auto.last_error = params[3];
        }
        return { rowCount: auto ? 1 : 0, rows: [] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

console.log('verify:staff-automated-notifications-live\n');

const lib = fs.existsSync(libPath) ? read(libPath) : '';
const runner = fs.existsSync(runnerPath) ? read(runnerPath) : '';

console.log('── live gate helpers ──');
ok('checkStaffAutomatedNotificationsLiveGates exported', /checkStaffAutomatedNotificationsLiveGates/.test(lib));
ok('parseStaffAutomatedNotificationsAllowedPhones exported', /parseStaffAutomatedNotificationsAllowedPhones/.test(lib));
ok('runDueStaffAutomatedNotificationsLive exported', /runDueStaffAutomatedNotificationsLive/.test(lib));
ok('buildStaffAutomatedNotificationLiveMessage exported', /buildStaffAutomatedNotificationLiveMessage/.test(lib));
ok('lib references LIVE_ENABLED env', /STAFF_AUTOMATED_NOTIFICATIONS_LIVE_ENABLED/.test(lib));
ok('lib references ALLOWED_PHONES env', /STAFF_AUTOMATED_NOTIFICATIONS_ALLOWED_PHONES/.test(lib));
ok('lib references WHATSAPP_DRY_RUN gate', /WHATSAPP_DRY_RUN/.test(lib));
ok('lib does not import sendLunaWhatsAppMessage', !/sendLunaWhatsAppMessage/.test(lib));
ok('lib uses injected sendMessage callback', /sendMessage/.test(lib));
ok('live message includes footer', buildStaffAutomatedNotificationLiveMessage('Daily check', 'All good').includes('Automated Luna Staff notification'));

const gateFail = checkStaffAutomatedNotificationsLiveGates({
  liveFlag: false,
  env: { WHATSAPP_DRY_RUN: 'false', STAFF_AUTOMATED_NOTIFICATIONS_LIVE_ENABLED: 'true', STAFF_AUTOMATED_NOTIFICATIONS_ALLOWED_PHONES: '+34111' },
});
ok('gate fails without --live flag', !gateFail.ok && gateFail.reasons.includes('cli_flag_--live_required'));

const gateNoAllow = checkStaffAutomatedNotificationsLiveGates({
  liveFlag: true,
  env: { WHATSAPP_DRY_RUN: 'false', STAFF_AUTOMATED_NOTIFICATIONS_LIVE_ENABLED: 'true' },
});
ok('gate fails without allowed phones env', !gateNoAllow.ok);

const gateDryRun = checkStaffAutomatedNotificationsLiveGates({
  liveFlag: true,
  env: { WHATSAPP_DRY_RUN: 'true', STAFF_AUTOMATED_NOTIFICATIONS_LIVE_ENABLED: 'true', STAFF_AUTOMATED_NOTIFICATIONS_ALLOWED_PHONES: '+34111' },
});
ok('gate fails when WHATSAPP_DRY_RUN not false', !gateDryRun.ok);

const gateOk = checkStaffAutomatedNotificationsLiveGates({
  liveFlag: true,
  env: {
    WHATSAPP_DRY_RUN: 'false',
    STAFF_AUTOMATED_NOTIFICATIONS_LIVE_ENABLED: 'true',
    STAFF_AUTOMATED_NOTIFICATIONS_ALLOWED_PHONES: '+34111,+34222',
  },
});
ok('gate passes when all env gates set', gateOk.ok);
ok('allowed phones parsed', parseStaffAutomatedNotificationsAllowedPhones('+34111, +34222').length === 2);

console.log('\n── runner live wiring ──');
ok('runner imports live helper', /runDueStaffAutomatedNotificationsLive/.test(runner));
ok('runner imports sendLunaWhatsAppMessage', /sendLunaWhatsAppMessage/.test(runner));
ok('runner checks live gates before live run', /checkStaffAutomatedNotificationsLiveGates/.test(runner));
ok('runner default remains dry-run', /runDueStaffAutomatedNotificationsDryRun/.test(runner));
ok('runner live path uses gate check', /if \(opts\.live\)/.test(runner) && /checkStaffAutomatedNotificationsLiveGates/.test(runner));
ok('no cron/timer in runner', !/setInterval|cron|node-cron|scheduleJob/.test(runner));
ok('no cron/timer in lib live block', !/setInterval|node-cron|scheduleJob/.test(lib));

console.log('\n── CLI gate rejection ──');
const liveNoEnv = spawnSync(process.execPath, [runnerPath, '--live'], { encoding: 'utf8' });
ok('--live without env gates exits non-zero', liveNoEnv.status !== 0);
ok('--live without env gates prints blocked reason', `${liveNoEnv.stderr || ''}`.includes('Live send blocked'));
ok('--live without env gates mentions LIVE_ENABLED', `${liveNoEnv.stderr || ''}`.includes('STAFF_AUTOMATED_NOTIFICATIONS_LIVE_ENABLED'));

const mon930Utc = new Date('2026-07-07T07:30:00.000Z');
const localParts = getAutomationLocalParts(mon930Utc, 'Europe/Madrid');
const automation = {
  id: 'auto-live-1',
  client_slug: 'wolfhouse-somo',
  location_id: null,
  title: 'Morning briefing',
  enabled: true,
  days_of_week: [localParts.weekday],
  local_time: '09:30',
  timezone: 'Europe/Madrid',
  prompt: 'Who is checking in today?',
  recipients: [
    { phone: '+34900000001', name: 'Desk' },
    { phone: '+34900000002', name: 'Other' },
  ],
};

async function runAsyncTests() {
  console.log('\n── unit: gate failure does not call Ask Luna or send ──');
  let askCalls = 0;
  let sendCalls = 0;
  const pgEmpty = createMockPg({ automations: [{ ...automation }] });
  try {
    await runDueStaffAutomatedNotificationsLive(pgEmpty, {
      now: mon930Utc,
      windowMinutes: 0,
      allowedPhones: [],
      executeQuestion: async () => { askCalls += 1; return { success: true, answer: 'x' }; },
      sendMessage: async () => { sendCalls += 1; return { success: true, send_performed: true }; },
    });
    ok('empty allowlist throws before due processing', false);
  } catch (err) {
    ok('empty allowlist throws before due processing', /allowedPhones required/.test(String(err.message)));
  }
  ok('no Ask Luna when allowlist invalid', askCalls === 0);
  ok('no send when allowlist invalid', sendCalls === 0);

  console.log('\n── unit: not-allowed phone skips Ask Luna ──');
  askCalls = 0;
  sendCalls = 0;
  const pgNoAllow = createMockPg({ automations: [{ ...automation, recipients: [{ phone: '+34900000002', name: 'Other' }] }] });
  const skipSummary = await runDueStaffAutomatedNotificationsLive(pgNoAllow, {
    now: mon930Utc,
    windowMinutes: 0,
    allowedPhones: ['+34900000001'],
    executeQuestion: async () => { askCalls += 1; return { success: true, answer: 'x' }; },
    sendMessage: async () => { sendCalls += 1; return { success: true, send_performed: true }; },
  });
  ok('recipient not on allowlist skipped', skipSummary.skipped_count === 1);
  ok('no Ask Luna when no eligible recipients', askCalls === 0);
  ok('no send when no eligible recipients', sendCalls === 0);

  console.log('\n── unit: dedupe pre-check prevents repeated Ask Luna/send ──');
  askCalls = 0;
  sendCalls = 0;
  const pgDedupe = createMockPg({
    automations: [{
      ...automation,
      recipients: [{ phone: '+34900000001', name: 'Desk' }],
    }],
  });
  const dedupeKey = buildStaffAutomatedNotificationDedupeKey(
    pgDedupe.automations[0],
    '2026-07-07',
    '09:30',
  );
  pgDedupe.events.push({
    dedupe_key: dedupeKey,
    recipient_phone: '+34900000001',
    status: 'sent',
  });

  const dedupeSummary = await runDueStaffAutomatedNotificationsLive(pgDedupe, {
    now: mon930Utc,
    windowMinutes: 0,
    allowedPhones: ['+34900000001'],
    executeQuestion: async () => { askCalls += 1; return { success: true, answer: 'ignored' }; },
    sendMessage: async () => { sendCalls += 1; return { success: true, send_performed: true }; },
  });
  ok('dedupe skips existing recipient', dedupeSummary.skipped_count >= 1);
  ok('dedupe prevents Ask Luna when no eligible left', askCalls === 0);
  ok('dedupe prevents send when no eligible left', sendCalls === 0);

  console.log('\n── unit: successful send records sent ──');
  askCalls = 0;
  sendCalls = 0;
  const pgSend = createMockPg({ automations: [{ ...automation, recipients: [{ phone: '+34900000001', name: 'Desk' }] }] });
  const sendSummary = await runDueStaffAutomatedNotificationsLive(pgSend, {
    now: mon930Utc,
    windowMinutes: 0,
    allowedPhones: ['+34900000001'],
    executeQuestion: async () => {
      askCalls += 1;
      return { success: true, answer: 'Two guests arrive today.' };
    },
    sendMessage: async (input) => {
      sendCalls += 1;
      ok('live message includes title and footer', input.message.includes('Morning briefing') && input.message.includes('Automated Luna Staff notification'));
      return { success: true, send_performed: true, whatsapp_message_id: 'wamid.test' };
    },
  });
  ok('Ask Luna called once for eligible automation', askCalls === 1);
  ok('send called once per eligible recipient', sendCalls === 1);
  ok('successful send counted', sendSummary.sent_count === 1);
  ok('event status sent', pgSend.events[0].status === 'sent');
  ok('automation last_status sent', pgSend.automations[0].last_status === 'sent');

  console.log('\n── unit: send failure records failed ──');
  const pgFail = createMockPg({ automations: [{ ...automation, id: 'auto-live-2', recipients: [{ phone: '+34900000001', name: 'Desk' }] }] });
  const failSummary = await runDueStaffAutomatedNotificationsLive(pgFail, {
    now: mon930Utc,
    windowMinutes: 0,
    allowedPhones: ['+34900000001'],
    executeQuestion: async () => ({ success: true, answer: 'Answer text' }),
    sendMessage: async () => ({ success: false, send_performed: false, blocked_reason: 'provider_down' }),
  });
  ok('send failure counted', failSummary.failed_count === 1);
  ok('failed event stored', pgFail.events[0].status === 'failed');
  ok('failed event has error', pgFail.events[0].error === 'provider_down');
  ok('automation last_status failed', pgFail.automations[0].last_status === 'failed');

  console.log('\n── regression verifiers ──');
  for (const script of [
    'verify-staff-automated-notifications-runner.js',
    'verify-staff-automated-notification-ui.js',
    'verify-staff-automated-notifications-crud.js',
  ]) {
    const out = spawnSync(process.execPath, [`scripts/${script}`], { cwd: ROOT, encoding: 'utf8' });
    ok(`${script} passes`, out.status === 0);
    if (out.status !== 0) console.log(`${out.stdout || ''}${out.stderr || ''}`.trim());
  }

  console.log(`\n── staff-automated-notifications-live: ${pass} passed, ${fail} failed ──`);
  process.exit(fail ? 1 : 0);
}

runAsyncTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
