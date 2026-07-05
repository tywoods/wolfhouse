'use strict';

/**
 * Verifier for automated staff notifications dry-run runner (no DB network, no migrations run).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const migrationPath = path.join(ROOT, 'database', 'migrations', '033_staff_automated_notifications.sql');
const libPath = path.join(ROOT, 'scripts', 'lib', 'staff-automated-notifications.js');
const runnerPath = path.join(ROOT, 'scripts', 'run-staff-automated-notifications.js');

const {
  buildStaffAutomatedNotificationDedupeKey,
  isAutomationDueNow,
  getAutomationLocalParts,
  runDueStaffAutomatedNotificationsDryRun,
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

console.log('verify:staff-automated-notifications-runner\n');

const migration = fs.existsSync(migrationPath) ? read(migrationPath) : '';
const lib = fs.existsSync(libPath) ? read(libPath) : '';
const runner = fs.existsSync(runnerPath) ? read(runnerPath) : '';

console.log('── migration audit table ──');
ok('events table in migration', /CREATE TABLE IF NOT EXISTS staff_automated_notification_events/i.test(migration));
ok('dedupe unique index', /uq_staff_automated_notification_events_dedupe/i.test(migration));
ok('dedupe index on dedupe_key and recipient_phone', /\(dedupe_key, recipient_phone\)/.test(migration));
ok('client created_at index', /idx_staff_automated_notification_events_client_created/i.test(migration));

console.log('\n── helper exports ──');
ok('listDueStaffAutomatedNotifications', /function listDueStaffAutomatedNotifications/.test(lib));
ok('buildStaffAutomatedNotificationDedupeKey', /function buildStaffAutomatedNotificationDedupeKey/.test(lib));
ok('recordStaffAutomatedNotificationEvent', /function recordStaffAutomatedNotificationEvent/.test(lib));
ok('runDueStaffAutomatedNotificationsDryRun', /function runDueStaffAutomatedNotificationsDryRun/.test(lib));
ok('lib does not import WhatsApp sender', !/sendLunaWhatsAppMessage/.test(lib));
ok('lib does not import Ask Luna executor', !/executeStaffAskLunaQuestion/.test(lib));
ok('lib uses injected executeQuestion callback', /executeQuestion/.test(lib));

console.log('\n── runner CLI ──');
ok('runner script exists', !!runner);
ok('runner supports --now', runner.includes('--now='));
ok('runner supports --client', runner.includes('--client='));
ok('runner supports --location', runner.includes('--location='));
ok('runner supports --window-minutes', runner.includes('--window-minutes='));
ok('runner supports --live flag', runner.includes('--live'));
ok('runner checks live gates when --live', /checkStaffAutomatedNotificationsLiveGates/.test(runner));
ok('runner calls dry-run helper by default', /runDueStaffAutomatedNotificationsDryRun/.test(runner));
ok('runner wires Ask Luna in CLI only', /executeStaffAskLunaQuestion/.test(runner));
ok('runner imports WhatsApp sender for gated live path', /sendLunaWhatsAppMessage/.test(runner));
ok('runner prints summary JSON', /due_count/.test(runner) && /dry_run_count/.test(runner));
ok('no cron/timer in runner', !/setInterval|cron|node-cron|scheduleJob/.test(runner));
ok('no cron/timer in lib runner block', !/setInterval|node-cron|scheduleJob/.test(lib));

console.log('\n── unit: due + dedupe + dry-run ──');
ok('dedupe key is stable', buildStaffAutomatedNotificationDedupeKey(
  { id: 'a1', client_slug: 'wolfhouse-somo', location_id: null },
  '2026-07-07',
  '09:30',
) === 'a1::wolfhouse-somo::::2026-07-07::09:30');

const mon930Utc = new Date('2026-07-07T07:30:00.000Z'); // 09:30 Europe/Madrid in July (CEST)
const automation = {
  id: 'auto-1',
  client_slug: 'wolfhouse-somo',
  location_id: null,
  enabled: true,
  days_of_week: [1],
  local_time: '09:30',
  timezone: 'Europe/Madrid',
  prompt: 'Who is checking in today?',
  recipients: [{ phone: '+34900000001', name: 'Desk' }],
};
const localParts = getAutomationLocalParts(mon930Utc, 'Europe/Madrid');
ok('local weekday mapping uses Mon=0', localParts.weekday === 1);
ok('due at exact minute with zero window', !!isAutomationDueNow(automation, mon930Utc, 0));
ok('not due outside window', !isAutomationDueNow(automation, new Date('2026-07-07T07:45:00.000Z'), 0));

async function runAsyncTests() {
  const pg = createMockPg({
    automations: [{
      ...automation,
      enabled: true,
      days_of_week: [localParts.weekday],
    }],
  });
  const summary = await runDueStaffAutomatedNotificationsDryRun(pg, {
    now: mon930Utc,
    windowMinutes: 0,
    executeQuestion: async () => ({ success: true, answer: 'Two guests arrive today.' }),
  });
  ok('dry-run writes event', summary.event_count === 1);
  ok('dry-run status counted', summary.dry_run_count === 1);
  ok('automation last_run updated', pg.automations[0].last_status === 'dry_run');
  ok('event stores answer preview', pg.events[0].answer_preview === 'Two guests arrive today.');
  ok('event status dry_run', pg.events[0].status === 'dry_run');

  const summaryDup = await runDueStaffAutomatedNotificationsDryRun(pg, {
    now: mon930Utc,
    windowMinutes: 0,
    executeQuestion: async () => ({ success: true, answer: 'ignored' }),
  });
  ok('duplicate run skips new events', summaryDup.skipped_count === 1 && summaryDup.event_count === 0);

  const pgFail = createMockPg({
    automations: [{
      ...automation,
      id: 'auto-2',
      enabled: true,
      days_of_week: [localParts.weekday],
    }],
  });
  const failSummary = await runDueStaffAutomatedNotificationsDryRun(pgFail, {
    now: mon930Utc,
    windowMinutes: 0,
    executeQuestion: async () => ({ success: false, error: 'query_error' }),
  });
  ok('failed ask records failed event', failSummary.failed_count === 1);
  ok('failed event stores error', pgFail.events[0].status === 'failed');

  console.log('\n── CLI live gate rejection ──');
  const liveRun = spawnSync(process.execPath, [runnerPath, '--live'], { encoding: 'utf8' });
  ok('--live without env gates exits non-zero', liveRun.status !== 0);
  ok('--live without env gates prints blocked reason', `${liveRun.stderr || ''}${liveRun.stdout || ''}`.includes('Live send blocked'));

  console.log('\n── regression verifiers ──');
  for (const script of [
    'verify-staff-automated-notification-ui.js',
    'verify-staff-automated-notifications-crud.js',
  ]) {
    const out = spawnSync(process.execPath, [`scripts/${script}`], { cwd: ROOT, encoding: 'utf8' });
    ok(`${script} passes`, out.status === 0);
    if (out.status !== 0) console.log(`${out.stdout || ''}${out.stderr || ''}`.trim());
  }

  console.log(`\n── staff-automated-notifications-runner: ${pass} passed, ${fail} failed ──`);
  process.exit(fail ? 1 : 0);
}

runAsyncTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
