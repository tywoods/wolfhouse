'use strict';

/**
 * Static verifier for Automated Staff Notifications CRUD (migration + lib + API routes).
 * No DB, no network, no migrations run.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const migrationPath = path.join(ROOT, 'database', 'migrations', '033_staff_automated_notifications.sql');
const libPath = path.join(ROOT, 'scripts', 'lib', 'staff-automated-notifications.js');
const apiPath = path.join(ROOT, 'scripts', 'staff-query-api.js');
const routesPath = path.join(ROOT, 'scripts', 'lib', 'staff-automated-notifications-routes.js');

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

console.log('verify:staff-automated-notifications-crud\n');

const migration = fs.existsSync(migrationPath) ? read(migrationPath) : '';
const lib = fs.existsSync(libPath) ? read(libPath) : '';
const api = fs.existsSync(apiPath) ? read(apiPath) : '';
const routesMod = fs.existsSync(routesPath) ? read(routesPath) : '';
const handlerSrc = api + '\n' + routesMod;

console.log('── migration 033 ──');
ok('migration file exists', !!migration);
ok('staff_automated_notifications table', /CREATE TABLE IF NOT EXISTS staff_automated_notifications/i.test(migration));
ok('recipients JSONB column', /recipients\s+JSONB/i.test(migration));
ok('days_of_week INT[] column', /days_of_week\s+INT\[\]/i.test(migration));
ok('last_status check constraint', /last_status IS NULL OR last_status IN/i.test(migration));
ok('tenant/location listing index', /idx_staff_automated_notifications_client_location/i.test(migration));
ok('enabled/time lookup index', /idx_staff_automated_notifications_enabled_time/i.test(migration));
ok('client updated_at index', /idx_staff_automated_notifications_client_updated/i.test(migration));

console.log('\n── migration audit events ──');
ok('events table in migration', /staff_automated_notification_events/i.test(migration));
ok('dedupe unique index on events', /uq_staff_automated_notification_events_dedupe/i.test(migration));

console.log('\n── helper module ──');
ok('ensureStaffAutomatedNotificationsTables exported', /function ensureStaffAutomatedNotificationsTables/.test(lib));
ok('listStaffAutomatedNotifications exported', /function listStaffAutomatedNotifications/.test(lib));
ok('createStaffAutomatedNotification exported', /function createStaffAutomatedNotification/.test(lib));
ok('updateStaffAutomatedNotification exported', /function updateStaffAutomatedNotification/.test(lib));
ok('deleteStaffAutomatedNotification exported', /function deleteStaffAutomatedNotification/.test(lib));
ok('validateAutomatedNotificationInput helper', /function validateAutomatedNotificationInput/.test(lib));
ok('recipient validation queries wolfhouse_staff_whatsapp_numbers', /wolfhouse_staff_whatsapp_numbers/.test(lib));
ok('resolveRecipientsFromStaffNumbers helper', /function resolveRecipientsFromStaffNumbers/.test(lib));
ok('active staff number requirement', /active = TRUE/.test(lib));
ok('scope filter uses COALESCE(location_id', /COALESCE\(location_id, ''\)/.test(lib));
ok('title max 120 validation', /TITLE_MAX = 120/.test(lib));
ok('prompt max 2000 validation', /PROMPT_MAX = 2000/.test(lib));
ok('recipients 1-10 validation', /MIN_RECIPIENTS = 1/.test(lib) && /MAX_RECIPIENTS = 10/.test(lib));
ok('days_of_week 0-6 validation', /days_of_week must be unique integers 0-6/.test(lib));
ok('persisted recipient shape', /staff_number_id/.test(lib) && /permission_group/.test(lib));

console.log('\n── API routes ──');
ok('GET /staff/automated-notifications route',
  /pathname === (?:'\/staff\/automated-notifications'|AUTOMATED_NOTIFICATIONS_PATH) && method === 'GET'/.test(handlerSrc));
ok('POST /staff/automated-notifications route',
  /pathname === (?:'\/staff\/automated-notifications'|AUTOMATED_NOTIFICATIONS_PATH) && method === 'POST'/.test(handlerSrc));
ok('PUT /staff/automated-notifications/:id route', /automatedNotificationMatch && method === 'PUT'/.test(api));
ok('DELETE /staff/automated-notifications/:id route', /automatedNotificationMatch && method === 'DELETE'/.test(api));
ok('admin auth on automated routes', /handleAutomatedNotificationsGet/.test(handlerSrc) && /requireAuth\(req, res, 'admin'\)/.test(api));
ok('client access assert on list handler', /handleAutomatedNotificationsGet[\s\S]*assertStaffClientAccess/.test(handlerSrc));
ok('lib wired into staff-query-api', /require\('\.\/lib\/staff-automated-notifications'\)/.test(api));
ok('routes module wired', /require\('\.\/lib\/staff-automated-notifications-routes'\)/.test(api));

console.log('\n── forbidden side effects ──');
// Collection handlers live in routes module; :id PUT/DELETE remain in staff-query-api.
const collectionHandlers = (routesMod.match(/async function handleAutomatedNotificationsGet[\s\S]*?const handlers = Object\.freeze/) || [''])[0];
const putDelHandlers = (api.match(/async function handleAutomatedNotificationsPut[\s\S]*?async function handleBotHouseInfo/) || [''])[0];
const automatedHandlers = collectionHandlers + '\n' + putDelHandlers;
ok('handler bodies located for side-effect scan', collectionHandlers.length > 100 && putDelHandlers.length > 100);
ok('handlers do not call sendLunaWhatsAppMessage', !/sendLunaWhatsAppMessage/.test(automatedHandlers));
ok('handlers do not call executeStaffAskLunaQuestion', !/executeStaffAskLunaQuestion/.test(automatedHandlers));
ok('automated route block does not call sendLunaWhatsAppMessage', !/automated-notifications[\s\S]{0,1200}sendLunaWhatsAppMessage/.test(api));
ok('automated route block does not call executeStaffAskLunaQuestion', !/automated-notifications[\s\S]{0,1200}executeStaffAskLunaQuestion/.test(api));
ok('lib does not import WhatsApp sender', !/sendLunaWhatsAppMessage/.test(lib));
ok('lib does not import Ask Luna executor', !/executeStaffAskLunaQuestion/.test(lib));

console.log('\n── frontend safety (no runner/send) ──');
const asnUiStart = api.indexOf('function automatedStaffNotificationsQuery');
const asnUiEnd = api.indexOf('function staffWhatsappNumbersRender', asnUiStart);
const asnUiBlock = asnUiStart >= 0 && asnUiEnd > asnUiStart ? api.slice(asnUiStart, asnUiEnd) : '';
ok('frontend ASN block has no setInterval', !/setInterval/.test(asnUiBlock));
ok('frontend ASN block has no cron/scheduler', !/cron|scheduler|due-check/i.test(asnUiBlock));
ok('frontend ASN block has no WhatsApp sender', !/sendLunaWhatsAppMessage/.test(asnUiBlock));
ok('frontend ASN block has no Ask Luna executor', !/executeStaffAskLunaQuestion/.test(asnUiBlock));
ok('frontend ASN block has no send test now', !/send test now/i.test(asnUiBlock));

console.log('\n── UI verifier regression ──');
const uiVerify = spawnSync(process.execPath, ['scripts/verify-staff-automated-notification-ui.js'], {
  cwd: ROOT,
  encoding: 'utf8',
});
const uiOut = `${uiVerify.stdout || ''}${uiVerify.stderr || ''}`.trim();
ok('verify-staff-automated-notification-ui exits 0', uiVerify.status === 0);
if (uiVerify.status !== 0 && uiOut) console.log(uiOut);

console.log(`\n── staff-automated-notifications-crud: ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
