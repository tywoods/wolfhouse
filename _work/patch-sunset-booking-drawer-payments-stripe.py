#!/usr/bin/env python3
"""Sunset booking drawer — editable fields, itemized payments, test Stripe links."""
from pathlib import Path
import shutil
import re

ROOT = Path("/opt/wolfhouse/WH")
API = ROOT / "scripts/staff-query-api.js"
I18N = ROOT / "scripts/lib/staff-portal-i18n.js"
I18N_ES = ROOT / "scripts/lib/staff-portal-i18n-es-sunset.js"
V1 = ROOT / "scripts/verify-sunset-portal-v1.js"
WRITES = ROOT / "scripts/lib/sunset-schedule-booking-writes.js"
DRAWER_MOD = ROOT / "scripts/lib/sunset-schedule-booking-drawer.js"
STRIPE_MOD = ROOT / "scripts/lib/sunset-stripe-payment-links.js"
DRAWER_UI = ROOT / "_work/sunset-schedule-drawer-ui.js"

for src, dst in [
    (ROOT / "_work/sunset-stripe-payment-links.js", STRIPE_MOD),
    (ROOT / "_work/sunset-schedule-booking-drawer.js", DRAWER_MOD),
]:
    if not src.exists():
        raise SystemExit(f"MISSING {src}")
    shutil.copyfile(src, dst)

# Extend writes exports
writes = WRITES.read_text(encoding="utf-8")
old_exports = """module.exports = {
  SUNSET_CLIENT_SLUG,
  METADATA_SOURCE_TAG,
  DB_SOURCE,
  DEFAULT_LESSON_CATEGORY,
  UI_COMPONENT_KEYS,
  LEGACY_UI_SERVICE_TYPES,
  validateScheduleBookingBody,
  generateSunsetManualBookingCode,
  scheduleRowFromDb,
  createSunsetScheduleBooking,
};"""
new_exports = """module.exports = {
  SUNSET_CLIENT_SLUG,
  METADATA_SOURCE_TAG,
  DB_SOURCE,
  DEFAULT_LESSON_CATEGORY,
  UI_COMPONENT_KEYS,
  LEGACY_UI_SERVICE_TYPES,
  UI_TO_DB_SERVICE_TYPE,
  DB_TO_UI_SERVICE_TYPE,
  UI_TO_SR_PAYMENT,
  UI_TO_BOOKING_PAYMENT,
  validateScheduleBookingBody,
  bookingStatusFromPayment,
  componentList,
  insertServiceRecord,
  generateSunsetManualBookingCode,
  scheduleRowFromDb,
  createSunsetScheduleBooking,
};"""
if old_exports not in writes:
    raise SystemExit("MISSING writes module.exports block")
writes = writes.replace(old_exports, new_exports)
WRITES.write_text(writes, encoding="utf-8")

api = API.read_text(encoding="utf-8")

# imports
needle = "} = require('./lib/sunset-schedule-booking-writes');"
stripe_import = """} = require('./lib/sunset-schedule-booking-writes');
const {
  createSunsetScheduleStripeLink,
  getSunsetSchedulePaymentLink,
} = require('./lib/sunset-stripe-payment-links');
const {
  getSunsetScheduleBookingDrawerContext,
  updateSunsetScheduleBooking,
} = require('./lib/sunset-schedule-booking-drawer');"""
if "sunset-schedule-booking-drawer" not in api:
    if needle not in api:
        raise SystemExit("MISSING sunset-schedule-booking-writes import")
    api = api.replace(needle, stripe_import)

HANDLERS = r"""
async function handleSunsetScheduleBookingDetailGet(query, res, user) {
  const started = Date.now();
  const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
  if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');
  if (clientSlug !== SUNSET_CLIENT_SLUG) {
    return sendJSON(res, 403, { success: false, error: 'unsupported_client', client_slug: clientSlug });
  }
  if (!assertStaffClientAccess(user, clientSlug, res)) return;
  const bookingId = String(query.booking_id || '').trim();
  const bookingCode = String(query.booking_code || '').trim();
  const stripeAvailable = !!(STRIPE_LINKS_ENABLED && STRIPE_SECRET_KEY && !String(STRIPE_SECRET_KEY).startsWith('sk_live_'));
  try {
    const result = await withPgClient(async (pg) => getSunsetScheduleBookingDrawerContext(pg, {
      clientSlug, bookingId, bookingCode,
    }));
    appendAuditLog({
      ts: new Date().toISOString(),
      intent: 'api:sunset.schedule.booking_detail',
      category: 'schedule_api',
      client_slug: clientSlug,
      success: !!(result && result.ok),
      staff_user_id: user ? user.staff_user_id : null,
      elapsed_ms: Date.now() - started,
    });
    if (!result.ok) return sendJSON(res, result.status, { ...result.body, elapsed_ms: Date.now() - started });
    return sendJSON(res, result.status, {
      ...result.body,
      stripe_available: stripeAvailable,
      elapsed_ms: Date.now() - started,
    });
  } catch (err) {
    return sendJSON(res, 500, { success: false, error: 'read failed' });
  }
}

async function handleSunsetScheduleBookingUpdate(query, req, res, user) {
  const started = Date.now();
  const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
  if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');
  if (clientSlug !== SUNSET_CLIENT_SLUG) {
    return sendJSON(res, 403, { success: false, error: 'unsupported_client', client_slug: clientSlug });
  }
  if (!assertStaffClientAccess(user, clientSlug, res)) return;
  let body = {};
  try { body = JSON.parse(await readBody(req) || '{}'); } catch (_) { return send400(res, 'invalid JSON body'); }
  const bookingId = String(body.booking_id || query.booking_id || '').trim();
  try {
    const result = await withPgClient(async (pg) => updateSunsetScheduleBooking(pg, {
      clientSlug,
      bookingId,
      body,
      actor: { staff_user_id: user && user.staff_user_id, email: user && user.email },
    }));
    appendAuditLog({
      ts: new Date().toISOString(),
      intent: 'api:sunset.schedule.booking_update',
      category: 'schedule_api',
      client_slug: clientSlug,
      success: !!(result && result.ok),
      staff_user_id: user ? user.staff_user_id : null,
      elapsed_ms: Date.now() - started,
    });
    if (!result.ok) return sendJSON(res, result.status, { ...result.body, elapsed_ms: Date.now() - started });
    const stripeAvailable = !!(STRIPE_LINKS_ENABLED && STRIPE_SECRET_KEY && !String(STRIPE_SECRET_KEY).startsWith('sk_live_'));
    const ctx = result.body && result.body.context;
    if (ctx) ctx.stripe_available = stripeAvailable;
    return sendJSON(res, result.status, { ...result.body, elapsed_ms: Date.now() - started });
  } catch (err) {
    return sendJSON(res, 500, { success: false, error: 'update failed', detail: err.message });
  }
}

async function handleSunsetSchedulePaymentLinkGet(query, res, user) {
  const started = Date.now();
  const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
  if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');
  if (clientSlug !== SUNSET_CLIENT_SLUG) {
    return sendJSON(res, 403, { success: false, error: 'unsupported_client', client_slug: clientSlug });
  }
  if (!assertStaffClientAccess(user, clientSlug, res)) return;
  const bookingId = String(query.booking_id || '').trim();
  const bookingCode = String(query.booking_code || '').trim();
  try {
    const result = await withPgClient(async (pg) => getSunsetSchedulePaymentLink(pg, {
      clientSlug, bookingId, bookingCode,
    }));
    appendAuditLog({
      ts: new Date().toISOString(),
      intent: 'api:sunset.schedule.payment_link_get',
      category: 'schedule_api',
      client_slug: clientSlug,
      success: !!(result && result.ok),
      staff_user_id: user ? user.staff_user_id : null,
      elapsed_ms: Date.now() - started,
    });
    if (!result.ok) return sendJSON(res, result.status, { ...result.body, elapsed_ms: Date.now() - started });
    return sendJSON(res, result.status, { ...result.body, elapsed_ms: Date.now() - started });
  } catch (err) {
    return sendJSON(res, 500, { success: false, error: 'read failed' });
  }
}

async function handleSunsetScheduleStripeLinkCreate(query, req, res, user) {
  const started = Date.now();
  const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
  if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');
  if (clientSlug !== SUNSET_CLIENT_SLUG) {
    return sendJSON(res, 403, { success: false, error: 'unsupported_client', client_slug: clientSlug });
  }
  if (!assertStaffClientAccess(user, clientSlug, res)) return;
  let body = {};
  try { body = JSON.parse(await readBody(req) || '{}'); } catch (_) { return send400(res, 'invalid JSON body'); }
  const bookingId = String(body.booking_id || query.booking_id || '').trim();
  const bookingCode = String(body.booking_code || query.booking_code || '').trim();
  const idempotencyKey = String(body.idempotency_key || '').trim();
  try {
    const result = await withPgClient(async (pg) => createSunsetScheduleStripeLink(pg, {
      clientSlug,
      bookingId,
      bookingCode,
      idempotencyKey,
      actor: { staff_user_id: user && user.staff_user_id, email: user && user.email },
      staffActionsEnabled: STAFF_ACTIONS_ENABLED,
      stripeLinksEnabled: STRIPE_LINKS_ENABLED,
      stripeSecretKey: STRIPE_SECRET_KEY,
      stripeSuccessUrl: stripeCheckoutSessionSuccessUrl(),
      stripeCancelUrl: stripeCheckoutSessionCancelUrl(),
    }));
    appendAuditLog({
      ts: new Date().toISOString(),
      intent: 'api:sunset.schedule.stripe_link_create',
      category: 'schedule_api',
      client_slug: clientSlug,
      success: !!(result && result.ok),
      staff_user_id: user ? user.staff_user_id : null,
      elapsed_ms: Date.now() - started,
    });
    if (!result.ok) return sendJSON(res, result.status, { ...result.body, elapsed_ms: Date.now() - started });
    return sendJSON(res, result.status, { ...result.body, elapsed_ms: Date.now() - started });
  } catch (err) {
    return sendJSON(res, 500, { success: false, error: 'stripe link create failed', detail: err.message });
  }
}

"""

marker = "async function handleSunsetScheduleBookingCreate(query, req, res, user) {"
if "handleSunsetScheduleBookingDetailGet" not in api:
    api = api.replace(marker, HANDLERS + marker)

ROUTE_BLOCK = """  if (pathname === '/staff/schedule/bookings/detail' && method === 'GET') {
    const auth = await requireAuth(req, res, 'viewer');
    if (!auth.ok) return;
    return handleSunsetScheduleBookingDetailGet(parsed.query, res, auth.user);
  }
  if (pathname === '/staff/schedule/bookings/stripe-link' && method === 'POST') {
    const auth = await requireAuth(req, res, 'operator');
    if (!auth.ok) return;
    return handleSunsetScheduleStripeLinkCreate(parsed.query, req, res, auth.user);
  }
  if (pathname === '/staff/schedule/bookings/payment-link' && method === 'GET') {
    const auth = await requireAuth(req, res, 'viewer');
    if (!auth.ok) return;
    return handleSunsetSchedulePaymentLinkGet(parsed.query, res, auth.user);
  }
"""
if "/staff/schedule/bookings/detail" not in api:
    api = api.replace(
        "  if (pathname === '/staff/schedule/bookings' && method === 'POST') {",
        ROUTE_BLOCK + "  if (pathname === '/staff/schedule/bookings' && method === 'PATCH') {\n"
        "    const auth = await requireAuth(req, res, 'operator');\n"
        "    if (!auth.ok) return;\n"
        "    return handleSunsetScheduleBookingUpdate(parsed.query, req, res, auth.user);\n"
        "  }\n"
        "  if (pathname === '/staff/schedule/bookings' && method === 'POST') {",
    )

# Insert drawer UI helpers before openScheduleDetailDrawer
ui_snippet = DRAWER_UI.read_text(encoding="utf-8")
ui_marker = "function openScheduleDetailDrawer(row){"
if "function scheduleDrawerEditableEnabled" not in api:
    api = api.replace(ui_marker, ui_snippet + "\n" + ui_marker)

# Replace openScheduleDetailDrawer body
old_drawer = re.search(
    r"function openScheduleDetailDrawer\(row\)\{[\s\S]*?\n\}\n\nfunction openScheduleDetailDrawerLegacyUnused",
    api,
)
if not old_drawer:
    raise SystemExit("MISSING openScheduleDetailDrawer block")

new_drawer = r"""function openScheduleDetailDrawer(row){
  if (!row) return;
  scheduleEnsureRowId(row);
  var group = scheduleFindGroupForRow(row) || scheduleBuildDisplayGroups([row])[0] || row;
  var drawer = el('ps-detail-drawer');
  var backdrop = el('ps-drawer-backdrop');
  var body = el('ps-drawer-body');
  if (!drawer || !body) return;
  scheduleLastDrawerRowId = row._scheduleId;
  if (scheduleDrawerEditableEnabled(row)){
    body.innerHTML = '<div class="state-msg">' + escHtml(portalT('schedule.drawer.loading')) + '</div>';
    drawer.style.display = 'block';
    if (backdrop) backdrop.style.display = 'block';
    scheduleFetchDrawerContext(row).then(function(data){
      if (!data || !data.success){
        body.innerHTML = '<div class="state-msg error">' + escHtml(portalT('schedule.drawer.loadFailed')) + '</div>';
        return;
      }
      scheduleOpenEditableDrawer(row, data);
    }).catch(function(){
      body.innerHTML = '<div class="state-msg error">' + escHtml(portalT('schedule.drawer.loadFailed')) + '</div>';
    });
    return;
  }
  var notes = group.notes || row.notes || row.message || '';
  body.innerHTML =
    '<div class="portal-schedule-drawer-hero">' +
    '<h3 style="margin:0 0 4px;font-size:22px">' + escHtml(group.guest_name || row.guest_name || 'Guest') + '</h3>' +
    '<p class="portal-schedule-card-sub" style="margin:0">' + escHtml(portalT('schedule.drawer.bookingCode')) + ': ' + escHtml(row.booking_code || '—') + '</p>' +
    '</div>' +
    '<p class="portal-schedule-drawer-kv"><strong>' + escHtml(portalT('schedule.drawer.source')) + ':</strong> ' + escHtml(scheduleRowSourceDrawerLabel(group)) + '</p>' +
    '<p class="portal-schedule-drawer-kv"><strong>' + escHtml(portalT('schedule.col.equipment')) + ':</strong> ' + escHtml(scheduleEquipmentPrepLabel(group)) + '</p>' +
    scheduleRenderComponentListHtml(group) +
    '<p class="portal-schedule-drawer-kv"><strong>' + escHtml(portalT('schedule.col.date')) + ':</strong> ' + escHtml(String(row.service_date || '—').slice(0, 10)) + '</p>' +
    '<p class="portal-schedule-drawer-kv"><strong>' + escHtml(portalT('schedule.col.payment')) + ':</strong> ' + scheduleRenderStatusBadgeHtml(group, { detail: true }) + '</p>' +
    (notes ? '<p class="portal-schedule-drawer-kv"><strong>' + escHtml(portalT('schedule.drawer.notes')) + ':</strong> ' + escHtml(notes) + '</p>' : '') +
    '<p class="portal-schedule-drawer-kv"><strong>' + escHtml(portalT('schedule.drawer.phone')) + ':</strong> ' + escHtml(group.phone || row.phone || '—') + '</p>' +
    '<div class="portal-schedule-drawer-actions">' +
    '<button type="button" class="btn btn-ghost" disabled title="' + escHtml(portalT('schedule.drawer.stripeSoon')) + '">' + escHtml(portalT('schedule.drawer.stripeLink')) + '</button>' +
    '<button type="button" class="btn btn-ghost" id="ps-drawer-conversation-btn">' + escHtml(portalT('schedule.drawer.startConv')) + '</button>' +
    '</div>' +
    '<p id="ps-drawer-conversation-hint" class="portal-schedule-drawer-hint" style="display:none"></p>' +
    '<p style="font-size:12px;color:var(--text-3);margin-top:14px">' + escHtml(portalT('schedule.drawer.readOnly')) + '</p>';
  drawer.style.display = 'block';
  if (backdrop) backdrop.style.display = 'block';
  scheduleWireDrawerConversation(row, group);
}

function openScheduleDetailDrawerLegacyUnused"""

api = api[:old_drawer.start()] + new_drawer + api[old_drawer.end():]

API.write_text(api, encoding="utf-8")

# i18n EN
i18n = I18N.read_text(encoding="utf-8")
replacements = [
    ("'schedule.drawer.stripeLink': 'Send Stripe link',", """'schedule.drawer.stripeLink': 'Create test Stripe link',
    'schedule.drawer.stripeRegenerate': 'Create new test Stripe link',
    'schedule.drawer.stripeSection': 'Stripe payment link',
    'schedule.drawer.stripeStatus': 'Link status',
    'schedule.drawer.stripeAmount': 'Amount',
    'schedule.drawer.stripeNone': 'No payment link yet.',
    'schedule.drawer.stripeCreated': 'Stripe payment link created. Nothing was sent to the guest.',
    'schedule.drawer.stripeFailed': 'Could not create Stripe link:',
    'schedule.drawer.stripeCopy': 'Copy link',
    'schedule.drawer.stripeOpen': 'Open link',
    'schedule.drawer.stripeUnavailable': 'Stripe test mode not configured on this environment.',
    'schedule.drawer.stripeStale': 'Outdated link',
    'schedule.drawer.stripeStaleHint': 'Booking changed since this link was created. Create a new test Stripe link for the updated total.',
    'schedule.drawer.paymentSection': 'Payment',
    'schedule.drawer.livePricingNote': 'Totals use current Admin prices when line amounts are not stored.',
    'schedule.drawer.noLineItems': 'No line items',
    'schedule.drawer.subtotal': 'Subtotal',
    'schedule.drawer.paid': 'Paid',
    'schedule.drawer.remaining': 'Remaining',
    'schedule.drawer.save': 'Save changes',
    'schedule.drawer.saved': 'Booking saved.',
    'schedule.drawer.saveFailed': 'Could not save booking:',
    'schedule.drawer.loading': 'Loading booking…',
    'schedule.drawer.loadFailed': 'Could not load booking details.',"""),
]
for old, new in replacements:
    if old.split("'")[1] not in i18n or old in i18n:
        if old in i18n:
            i18n = i18n.replace(old, new)
I18N.write_text(i18n, encoding="utf-8")

# i18n ES supplement
if I18N_ES.exists():
    es = I18N_ES.read_text(encoding="utf-8")
    es_keys = """
    'schedule.drawer.stripeLink': 'Crear enlace Stripe de prueba',
    'schedule.drawer.stripeRegenerate': 'Crear nuevo enlace Stripe de prueba',
    'schedule.drawer.stripeSection': 'Enlace de pago Stripe',
    'schedule.drawer.stripeCopy': 'Copiar enlace',
    'schedule.drawer.stripeOpen': 'Abrir enlace',
    'schedule.drawer.stripeUnavailable': 'Stripe modo prueba no configurado.',
    'schedule.drawer.stripeStale': 'Enlace desactualizado',
    'schedule.drawer.stripeStaleHint': 'La reserva cambió. Crea un nuevo enlace para el total actualizado.',
    'schedule.drawer.paymentSection': 'Pago',
    'schedule.drawer.livePricingNote': 'Los totales usan precios actuales de Admin si no hay importes guardados.',
    'schedule.drawer.subtotal': 'Subtotal',
    'schedule.drawer.remaining': 'Pendiente',
    'schedule.drawer.save': 'Guardar cambios',
    'schedule.drawer.saved': 'Reserva guardada.',
    'schedule.drawer.loading': 'Cargando reserva…',
"""
    if "'schedule.drawer.paymentSection'" not in es:
        es = es.replace("};", es_keys + "\n};")
        I18N_ES.write_text(es, encoding="utf-8")

# verify section 25 + update section 19/24 assertions
v1 = V1.read_text(encoding="utf-8")
v1 = v1.replace(
    "  assert('no stripe wired in drawer', apiSrc.includes(\"portalT('schedule.drawer.stripeSoon')\"));",
    "  assert('drawer stripe for non-editable only', apiSrc.includes(\"portalT('schedule.drawer.stripeSoon')\"));",
)
if "[25] Sunset booking drawer" not in v1:
    v1 = v1.replace(
        "console.log('\\n' + '─'.repeat(48));",
        """console.log('\\n[25] Sunset booking drawer — payments, edits, test Stripe');

if (apiSrc) {
  assert('drawer detail GET route', apiSrc.includes('/staff/schedule/bookings/detail'));
  assert('drawer PATCH route', apiSrc.includes("pathname === '/staff/schedule/bookings' && method === 'PATCH'"));
  assert('drawer update handler', apiSrc.includes('function handleSunsetScheduleBookingUpdate('));
  assert('drawer detail handler', apiSrc.includes('function handleSunsetScheduleBookingDetailGet('));
  assert('drawer payment section', apiSrc.includes('function scheduleRenderDrawerPaymentSectionHtml('));
  assert('drawer line item labels', apiSrc.includes('schedule.drawer.paymentSection'));
  assert('drawer totals paid remaining', apiSrc.includes('schedule.drawer.remaining') && apiSrc.includes('ps-drawer-paid'));
  assert('create test stripe link button', apiSrc.includes('ps-drawer-stripe-link') && apiSrc.includes('schedule.drawer.stripeLink'));
  assert('stripe no auto send message', apiSrc.includes('schedule.drawer.stripeCreated'));
  assert('drawer editable fields', apiSrc.includes('ps-drawer-guest') && apiSrc.includes('ps-drawer-board-qty'));
  assert('drawer save action', apiSrc.includes('function scheduleSaveDrawerBooking('));
  assert('stripe stale warning', apiSrc.includes('schedule.drawer.stripeStale'));
  assert('stripe unavailable disabled', apiSrc.includes('schedule.drawer.stripeUnavailable'));
  assert('drawer conversation action', apiSrc.includes('ps-drawer-conversation-btn'));
  assert('no whatsapp stripe send in drawer save', !apiSrc.includes('scheduleSaveDrawerBooking') || !apiSrc.slice(apiSrc.indexOf('scheduleCreateDrawerStripeLink'), apiSrc.indexOf('scheduleCreateDrawerStripeLink') + 800).match(/whatsapp|sendMessage|send_email/i));
}

const drawerModPath = path.join(ROOT, 'scripts/lib/sunset-schedule-booking-drawer.js');
if (fs.existsSync(drawerModPath)) {
  const drawerModSrc = fs.readFileSync(drawerModPath, 'utf8');
  assert('drawer module sunset only', drawerModSrc.includes("clientSlug !== SUNSET_CLIENT_SLUG"));
  assert('drawer marks stripe stale on update', drawerModSrc.includes('sunset_stripe_link_stale'));
  assert('drawer live pricing note', drawerModSrc.includes('live_pricing'));
}

const stripeModPath = path.join(ROOT, 'scripts/lib/sunset-stripe-payment-links.js');
if (fs.existsSync(stripeModPath)) {
  const stripeModSrc = fs.readFileSync(stripeModPath, 'utf8');
  assert('stripe module blocks live keys', stripeModSrc.includes('sk_live_'));
  assert('stripe module no whatsapp', !/whatsapp/i.test(stripeModSrc));
  assert('stripe respects stale metadata', stripeModSrc.includes('sunset_stripe_link_stale'));
}


console.log('\\n' + '─'.repeat(48));""",
    )
V1.write_text(v1, encoding="utf-8")

print("PATCH OK")
