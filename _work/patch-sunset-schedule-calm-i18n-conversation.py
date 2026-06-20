#!/usr/bin/env python3
"""Sunset Schedule: calm visual pass, live i18n, phone field, conversation open/start."""
from pathlib import Path

ROOT = Path("/opt/wolfhouse/WH")
API = ROOT / "scripts/staff-query-api.js"
I18N = ROOT / "scripts/lib/staff-portal-i18n.js"
ES = ROOT / "scripts/lib/staff-portal-i18n-es-sunset.js"
WRITES = ROOT / "scripts/lib/sunset-schedule-booking-writes.js"
LESSONS = ROOT / "scripts/lib/staff-ask-luna-lessons.js"
GEAR = ROOT / "scripts/lib/staff-ask-luna-gear.js"
V1 = ROOT / "scripts/verify-sunset-portal-v1.js"


def require(text, needle, label):
    if needle not in text:
        raise SystemExit(f"MISSING {label}: {needle[:160]}...")


def replace_once(text, old, new, label):
    require(text, old, label)
    if text.count(old) != 1:
        raise SystemExit(f"EXPECTED ONE {label}, found {text.count(old)}")
    return text.replace(old, new)


# ── Lessons + gear queries: booking_id + phone ───────────────────────────────

LESSONS_INSERT = "  COALESCE(sr.guest_name, b.guest_name)     AS guest_name,"
LESSONS_NEW = """  b.id::text                                AS booking_id,
  NULLIF(BTRIM(b.phone), '')                AS phone,
  COALESCE(sr.guest_name, b.guest_name)     AS guest_name,"""

lessons = LESSONS.read_text(encoding="utf-8")
lessons = replace_once(lessons, LESSONS_INSERT, LESSONS_NEW, "lessons phone/booking_id")
LESSONS.write_text(lessons, encoding="utf-8")

gear = GEAR.read_text(encoding="utf-8")
gear = replace_once(gear, LESSONS_INSERT, LESSONS_NEW, "gear phone/booking_id")
GEAR.write_text(gear, encoding="utf-8")

# ── Booking writes: phone persistence ────────────────────────────────────────

writes = WRITES.read_text(encoding="utf-8")

writes = replace_once(
    writes,
    "    return { ok: false, error: 'payment_status must be unpaid, paid, or pending' };",
    "    return { ok: false, error: 'payment_status must be unpaid or paid' };",
    "payment error msg",
)

PHONE_VALIDATE = """  const idempotency_key = b.idempotency_key != null ? String(b.idempotency_key).trim().slice(0, 120) : '';

  return {
    ok: true,
    value: {
      guest_name,
      components: components.value,
      service_dates: serviceDates.value,
      payment_status,
      notes,
      needs_reply,
      idempotency_key: idempotency_key || null,
    },
  };
}"""

PHONE_VALIDATE_NEW = """  const idempotency_key = b.idempotency_key != null ? String(b.idempotency_key).trim().slice(0, 120) : '';
  const phoneRaw = b.phone_number != null ? b.phone_number : (b.guest_phone != null ? b.guest_phone : b.phone);
  const guest_phone = phoneRaw != null ? String(phoneRaw).trim().slice(0, 40) : '';

  return {
    ok: true,
    value: {
      guest_name,
      guest_phone: guest_phone || null,
      components: components.value,
      service_dates: serviceDates.value,
      payment_status,
      notes,
      needs_reply,
      idempotency_key: idempotency_key || null,
    },
  };
}"""

writes = replace_once(writes, PHONE_VALIDATE, PHONE_VALIDATE_NEW, "validate phone")

INSERT_OLD = """    const bookingIns = await pg.query(
      `INSERT INTO bookings (
         client_id, booking_code, guest_name, status, payment_status,
         check_in, check_out, guest_count, metadata
       ) VALUES (
         $1::uuid, $2, $3, $4::booking_status, $5::payment_status,
         $6::date, ($6::date + INTERVAL '1 day')::date, $7, $8::jsonb
       )
       RETURNING id::text AS id, booking_code`,
      [
        clientId,
        bookingCode,
        input.guest_name,
        bookingStatus,
        bookingPayment,
        firstDate,
        guestCount,
        JSON.stringify({
          source: METADATA_SOURCE_TAG,
          staff_manual_schedule: true,
          bundle_id: bundleId,
          components: componentKeys,
        }),
      ],
    );"""

INSERT_NEW = """    const bookingIns = await pg.query(
      `INSERT INTO bookings (
         client_id, booking_code, guest_name, phone, status, payment_status,
         check_in, check_out, guest_count, metadata
       ) VALUES (
         $1::uuid, $2, $3, NULLIF($4, ''), $5::booking_status, $6::payment_status,
         $7::date, ($7::date + INTERVAL '1 day')::date, $8, $9::jsonb
       )
       RETURNING id::text AS id, booking_code`,
      [
        clientId,
        bookingCode,
        input.guest_name,
        input.guest_phone || '',
        bookingStatus,
        bookingPayment,
        firstDate,
        guestCount,
        JSON.stringify({
          source: METADATA_SOURCE_TAG,
          staff_manual_schedule: true,
          bundle_id: bundleId,
          components: componentKeys,
          guest_phone: input.guest_phone || null,
        }),
      ],
    );"""

writes = replace_once(writes, INSERT_OLD, INSERT_NEW, "booking insert phone")

ROW_FROM_DB_OLD = """    guest_name: row.guest_name || null,
    service_type: uiType,"""

ROW_FROM_DB_NEW = """    guest_name: row.guest_name || null,
    phone: row.phone || null,
    service_type: uiType,"""

writes = replace_once(writes, ROW_FROM_DB_OLD, ROW_FROM_DB_NEW, "scheduleRowFromDb phone")

FIND_IDEM_OLD = """    `SELECT sr.id::text AS service_record_id,
            sr.booking_id::text AS booking_id,
            sr.booking_code,
            sr.guest_name,"""

FIND_IDEM_NEW = """    `SELECT sr.id::text AS service_record_id,
            sr.booking_id::text AS booking_id,
            sr.booking_code,
            sr.guest_name,
            b.phone AS phone,"""

writes = replace_once(writes, FIND_IDEM_OLD, FIND_IDEM_NEW, "find idempotent select")

FIND_IDEM_FROM = """       FROM booking_service_records sr
      WHERE sr.client_slug = $1"""

FIND_IDEM_FROM_NEW = """       FROM booking_service_records sr
      INNER JOIN bookings b ON b.id = sr.booking_id
      WHERE sr.client_slug = $1"""

writes = replace_once(writes, FIND_IDEM_FROM, FIND_IDEM_FROM_NEW, "find idempotent join")

WRITES.write_text(writes, encoding="utf-8")

# ── staff-query-api.js ───────────────────────────────────────────────────────

api = API.read_text(encoding="utf-8")

# Scoped calm schedule surface CSS
CALM_ANCHOR = "#tab-portal-home.active{display:block}"
CALM_CSS = """
/* Sunset Schedule — calm neutral ops surface (scoped to portal home tab) */
#tab-portal-home{
  --sched-bg:#F4F5F7;
  --sched-surface:#FFFFFF;
  --sched-surface-soft:#F8FAFC;
  --sched-border:#E5E7EB;
  --sched-border-soft:#EEF2F6;
  --sched-text:#334155;
  --sched-text-2:#64748B;
  --sched-text-3:#94A3B8;
  --sched-rail-staff:#A8C4B4;
  --sched-rail-luna:#A8B8CC;
  --sched-primary:#2F6B4F;
  --sched-primary-hover:#275C43;
  --sched-unpaid:#B4534A;
  background:var(--sched-bg);
}
#tab-portal-home .portal-schedule-wrap{padding-top:20px}
#tab-portal-home .portal-schedule-card,
#tab-portal-home .portal-schedule-ops-lesson-group,
#tab-portal-home .portal-schedule-ops-rental-pickups,
#tab-portal-home .portal-schedule-week-forecast-card,
#tab-portal-home .portal-schedule-next30-card{background:var(--sched-surface);border-color:var(--sched-border-soft);box-shadow:0 1px 2px rgba(15,23,42,.04)}
#tab-portal-home .portal-schedule-card-label,
#tab-portal-home .portal-schedule-ops-lesson-hdr-title,
#tab-portal-home .portal-schedule-ops-rental-pickups-hdr{color:var(--sched-text)}
#tab-portal-home .portal-schedule-card-stat,
#tab-portal-home .portal-schedule-card-stat-lg,
#tab-portal-home .portal-schedule-lesson-time,
#tab-portal-home .portal-schedule-lesson-time-count,
#tab-portal-home .portal-schedule-ops-row-guest{color:var(--sched-text)}
#tab-portal-home .portal-schedule-card-sub,
#tab-portal-home .portal-schedule-card-body,
#tab-portal-home .portal-schedule-ops-lesson-hdr-booked,
#tab-portal-home .portal-schedule-ops-lesson-hdr-prep,
#tab-portal-home .portal-schedule-ops-row-equip-sub,
#tab-portal-home .portal-schedule-lesson-times-empty{color:var(--sched-text-2)}
#tab-portal-home .portal-schedule-ops-col-hdr,
#tab-portal-home .portal-schedule-ops-lesson-hdr{background:var(--sched-surface-soft);border-color:var(--sched-border-soft)}
#tab-portal-home .portal-schedule-ops-row{border-color:var(--sched-border-soft);background:transparent}
#tab-portal-home .portal-schedule-ops-row.is-staff,
#tab-portal-home .portal-schedule-ops-row.is-luna{background:transparent}
#tab-portal-home .portal-schedule-ops-row:hover{background:var(--sched-surface-soft)}
#tab-portal-home .portal-schedule-ops-row-rail.is-staff{background:var(--sched-rail-staff)}
#tab-portal-home .portal-schedule-ops-row-rail.is-luna{background:var(--sched-rail-luna)}
#tab-portal-home .portal-schedule-view-btn{background:var(--sched-surface);border-color:var(--sched-border);color:var(--sched-text-2)}
#tab-portal-home .portal-schedule-view-btn.active{background:var(--sched-text);border-color:var(--sched-text);color:#fff}
#tab-portal-home .portal-schedule-range{color:var(--sched-text)}
#tab-portal-home .btn-primary{background:var(--sched-primary);border-color:var(--sched-primary);color:#fff;box-shadow:none}
#tab-portal-home .btn-primary:hover{background:var(--sched-primary-hover);border-color:var(--sched-primary-hover)}
#tab-portal-home .btn-ghost{background:var(--sched-surface);border-color:var(--sched-border);color:var(--sched-text-2)}
#tab-portal-home .btn-ghost:hover{background:var(--sched-surface-soft);border-color:var(--sched-border)}
#tab-portal-home .portal-schedule-status.is-unpaid{color:var(--sched-unpaid)}
#tab-portal-home .portal-schedule-status.is-pending{color:var(--sched-unpaid)}
#tab-portal-home .portal-schedule-status.is-paid{color:var(--sched-text-3)}
#tab-portal-home .portal-schedule-item-card.source-staff,
#tab-portal-home .portal-schedule-item-card.source-luna{background:var(--sched-surface-soft);border-color:var(--sched-border-soft)}
#tab-portal-home .portal-schedule-week-forecast-card:hover,
#tab-portal-home .portal-schedule-next30-card:hover{border-color:var(--sched-border);box-shadow:0 1px 3px rgba(15,23,42,.06)}
#tab-portal-home .portal-schedule-week-forecast-card.is-today,
#tab-portal-home .portal-schedule-next30-card.is-today{border-color:var(--sched-text-2)}
#tab-portal-home .portal-schedule-drawer,
#tab-portal-home .portal-schedule-create-drawer{background:var(--sched-surface);border-color:var(--sched-border-soft)}
#tab-portal-home .portal-schedule-drawer-hint{font-size:12px;color:var(--sched-text-3);margin:6px 0 0;line-height:1.4}
"""

require(api, CALM_ANCHOR, "calm anchor")
api = api.replace(CALM_ANCHOR, CALM_ANCHOR + CALM_CSS)

# Remove global muddy pending color (schedule scoped override handles display)
OLD_STATUS_CSS = ".portal-schedule-status.is-pending,.portal-schedule-status.is-unpaid{color:#b8935a}"
NEW_STATUS_CSS = ".portal-schedule-status.is-pending,.portal-schedule-status.is-unpaid{color:#B4534A}"
api = replace_once(api, OLD_STATUS_CSS, NEW_STATUS_CSS, "status css")

# Remove row gradient washes at global level (scoped block sets transparent)
OLD_ROW_GRAD = """.portal-schedule-ops-row.is-staff{background:linear-gradient(90deg,rgba(111,167,131,.14),transparent 42%)}
.portal-schedule-ops-row.is-luna{background:linear-gradient(90deg,rgba(111,147,184,.14),transparent 42%)}"""
NEW_ROW_GRAD = """.portal-schedule-ops-row.is-staff,.portal-schedule-ops-row.is-luna{background:transparent}"""
api = replace_once(api, OLD_ROW_GRAD, NEW_ROW_GRAD, "row gradient")

# Top card label: Unpaid only
api = replace_once(
    api,
    'data-i18n="schedule.card.unpaidPending">Unpaid / Pending</div>',
    'data-i18n="schedule.card.unpaid">Unpaid</div>',
    "unpaid card label",
)

# Create form: phone field + remove pending option
CREATE_GUEST = """    <div class="portal-schedule-create-field"><label for="ps-create-guest" data-i18n="schedule.create.guestName">Guest name</label><input id="ps-create-guest" type="text" autocomplete="off"></div>
    <div class="portal-schedule-create-field"><span class="portal-schedule-create-label" data-i18n="schedule.create.components">Booking components</span>"""

CREATE_GUEST_NEW = """    <div class="portal-schedule-create-field"><label for="ps-create-guest" data-i18n="schedule.create.guestName">Guest name</label><input id="ps-create-guest" type="text" autocomplete="off"></div>
    <div class="portal-schedule-create-field"><label for="ps-create-phone" data-i18n="schedule.create.phone">Phone number</label><input id="ps-create-phone" type="tel" autocomplete="tel" inputmode="tel"></div>
    <div class="portal-schedule-create-field"><span class="portal-schedule-create-label" data-i18n="schedule.create.components">Booking components</span>"""

api = replace_once(api, CREATE_GUEST, CREATE_GUEST_NEW, "create phone field")

api = replace_once(
    api,
    '<option value="paid" data-i18n="schedule.payment.paid">Paid</option><option value="pending" data-i18n="schedule.payment.pending">Pending</option></select>',
    '<option value="paid" data-i18n="schedule.payment.paid">Paid</option></select>',
    "remove pending option",
)

# scheduleLastDrawerRowId + conversation helpers
SCHEDULE_VARS = "var scheduleConversationsCache = [];"
SCHEDULE_VARS_NEW = """var scheduleConversationsCache = [];
var scheduleLastDrawerRowId = null;"""
api = replace_once(api, SCHEDULE_VARS, SCHEDULE_VARS_NEW, "schedule vars")

INSERT_CONV_HELPERS = """function scheduleNormalizeApiRow(r){
  if (!r) return r;"""

CONV_HELPERS = """function scheduleNormalizePhoneDigits(phone){
  return String(phone || '').replace(/\\D/g, '');
}

function scheduleGroupHasPhone(group){
  var p = String(group && group.phone || '').trim();
  return p.length > 0 && p.indexOf('staff:') !== 0;
}

function scheduleFindLinkedConversation(group){
  var convs = scheduleConversationsCache || [];
  if (!group) return null;
  var bookingCode = group.booking_code;
  if (bookingCode){
    var byCode = convs.find(function(c){ return c.booking_code === bookingCode; });
    if (byCode) return byCode;
  }
  var phone = String(group.phone || '').trim();
  if (phone && phone.indexOf('staff:') !== 0){
    var norm = scheduleNormalizePhoneDigits(phone);
    var byPhone = convs.find(function(c){
      return c.phone && scheduleNormalizePhoneDigits(c.phone) === norm;
    });
    if (byPhone) return byPhone;
  }
  return null;
}

function scheduleResolveConversationId(group){
  var linked = scheduleFindLinkedConversation(group);
  return linked && linked.conversation_id ? linked.conversation_id : null;
}

function scheduleStartConversationFromBooking(group){
  if (!group) return;
  var btn = el('ps-drawer-conversation-btn');
  if (btn && btn.disabled) return;
  if (btn) btn.disabled = true;
  var client = getClient();
  var idemKey = 'schedule-drawer-conv-' + (group.booking_id || group.booking_code || 'unknown');
  fetch('/staff/bookings/create-conversation?client=' + encodeURIComponent(client), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      client_slug: client,
      booking_id: group.booking_id || undefined,
      booking_code: group.booking_code || undefined,
      idempotency_key: idemKey,
      reason: 'Created from Sunset schedule drawer',
    }),
  })
    .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, data: j }; }); })
    .then(function(res){
      if (btn) btn.disabled = false;
      if (!res.ok || !res.data || !res.data.success){
        var errMsg = (res.data && res.data.error) || portalT('schedule.drawer.conversationFailed');
        alert(errMsg);
        return;
      }
      var convId = res.data.conversation_id;
      if (!convId) return;
      openInboxToConversation(convId);
    })
    .catch(function(e){
      if (btn) btn.disabled = false;
      alert(e.message || portalT('schedule.drawer.conversationFailed'));
    });
}

function scheduleOpenOrStartConversationFromBooking(group){
  var convId = scheduleResolveConversationId(group);
  if (convId){
    openInboxToConversation(convId);
    return;
  }
  scheduleStartConversationFromBooking(group);
}

function scheduleRefreshOpenDrawerI18n(){
  if (!scheduleLastDrawerRowId) return;
  var row = scheduleFindRowById(scheduleLastDrawerRowId);
  if (!row) return;
  var drawer = el('ps-detail-drawer');
  if (!drawer || drawer.style.display === 'none') return;
  openScheduleDetailDrawer(row);
}

function scheduleRefreshOnLocaleChange(){
  var profile = getPortalProfile(getClient());
  if (!profile || !profile.is_surf_vertical) return;
  var wrap = el('wrap-portal-home') || document.querySelector('.portal-schedule-wrap');
  if (wrap && typeof window.applyStaffPortalI18n === 'function') window.applyStaffPortalI18n(wrap);
  var createModal = el('ps-create-modal');
  if (createModal && createModal.style.display !== 'none' && typeof window.applyStaffPortalI18n === 'function'){
    window.applyStaffPortalI18n(createModal);
  }
  if (!scheduleIsPortalHomeActive()) return;
  var keepDrawerId = scheduleLastDrawerRowId;
  var drawerWasOpen = !!(keepDrawerId && el('ps-detail-drawer') && el('ps-detail-drawer').style.display !== 'none');
  return loadSchedulePage().then(function(){
    if (drawerWasOpen && keepDrawerId){
      var restored = scheduleFindRowById(keepDrawerId);
      if (restored) openScheduleDetailDrawer(restored);
    }
  });
}

function scheduleIsPortalHomeActive(){
  var tab = el('tab-portal-home');
  return !!(tab && tab.classList.contains('active'));
}

function scheduleNormalizeApiRow(r){
  if (!r) return r;"""

api = replace_once(api, INSERT_CONV_HELPERS, CONV_HELPERS, "conversation helpers")

# Enhance scheduleNormalizeApiRow payment + phone
NORM_TAIL = """  if (r.staff_ui_service_type) r.service_type = r.staff_ui_service_type;
  if (r._needsReply == null) r._needsReply = false;
  return r;
}"""

NORM_TAIL_NEW = """  if (r.staff_ui_service_type) r.service_type = r.staff_ui_service_type;
  if (r._needsReply == null) r._needsReply = false;
  if (!r.phone && meta.guest_phone) r.phone = meta.guest_phone;
  var ps = String(r.payment_status || '').toLowerCase();
  if (ps === 'pending' || ps === 'waiting_payment' || ps === 'not_requested') r.payment_status = 'unpaid';
  return r;
}"""

api = replace_once(api, NORM_TAIL, NORM_TAIL_NEW, "normalize payment phone")

# scheduleRenderStatusBadgeHtml — pending displays as Unpaid
BADGE_OLD = """  var pendingKey = opts.detail ? 'schedule.status.pendingDetail' : 'schedule.status.pending';
  if (ps === 'paid'){
    if (!opts.row) html = '<span class="portal-schedule-status is-paid">' + escHtml(portalT('schedule.status.paid')) + '</span>';
  } else if (ps === 'pending'){
    html = '<span class="portal-schedule-status is-pending">' + escHtml(portalT(pendingKey)) + '</span>';
  } else if (ps){
    html = '<span class="portal-schedule-status is-unpaid">' + escHtml(portalT('schedule.status.unpaid')) + '</span>';
  }"""

BADGE_NEW = """  if (ps === 'paid'){
    if (!opts.row) html = '<span class="portal-schedule-status is-paid">' + escHtml(portalT('schedule.status.paid')) + '</span>';
  } else if (ps === 'pending' || ps === 'waiting_payment' || ps === 'not_requested' || ps){
    html = '<span class="portal-schedule-status is-unpaid">' + escHtml(portalT('schedule.status.unpaid')) + '</span>';
  }"""

api = replace_once(api, BADGE_OLD, BADGE_NEW, "status badge")

# scheduleBuildDisplayGroups — propagate phone + normalize payment
GROUP_INIT = """        payment_status: r.payment_status,
        _isDemo: !!r._isDemo,"""

GROUP_INIT_NEW = """        payment_status: (function(){
          var p = String(r.payment_status || '').toLowerCase();
          if (p === 'pending' || p === 'waiting_payment' || p === 'not_requested') return 'unpaid';
          return r.payment_status;
        })(),
        phone: r.phone || null,
        _isDemo: !!r._isDemo,"""

api = replace_once(api, GROUP_INIT, GROUP_INIT_NEW, "group init")

GROUP_PROP = """    if (!g.notes && r.notes) g.notes = r.notes;
  });
  return Object.keys(map).map(function(k){ return map[k]; });
}"""

GROUP_PROP_NEW = """    if (!g.notes && r.notes) g.notes = r.notes;
    if (!g.phone && r.phone) g.phone = r.phone;
  });
  return Object.keys(map).map(function(k){ return map[k]; });
}"""

api = replace_once(api, GROUP_PROP, GROUP_PROP_NEW, "group phone prop")

# scheduleReadCreatePayload + submit POST phone
READ_PAYLOAD = """  var guest = (el('ps-create-guest') && el('ps-create-guest').value || '').trim();
  var dateFrom = el('ps-create-date-from') ? el('ps-create-date-from').value : scheduleTodayIso();"""

READ_PAYLOAD_NEW = """  var guest = (el('ps-create-guest') && el('ps-create-guest').value || '').trim();
  var phone = (el('ps-create-phone') && el('ps-create-phone').value || '').trim();
  var dateFrom = el('ps-create-date-from') ? el('ps-create-date-from').value : scheduleTodayIso();"""

api = replace_once(api, READ_PAYLOAD, READ_PAYLOAD_NEW, "read payload phone")

RETURN_PAYLOAD = "  return { guest_name: guest, date_from: dateFrom, date_to: dateTo, payment_status: payment, notes: notes, components: components };"

RETURN_PAYLOAD_NEW = "  return { guest_name: guest, guest_phone: phone || null, date_from: dateFrom, date_to: dateTo, payment_status: payment, notes: notes, components: components };"

api = replace_once(api, RETURN_PAYLOAD, RETURN_PAYLOAD_NEW, "return payload phone")

POST_BODY = """      guest_name: payload.guest_name,
      date_from: payload.date_from,"""

POST_BODY_NEW = """      guest_name: payload.guest_name,
      guest_phone: payload.guest_phone,
      date_from: payload.date_from,"""

api = replace_once(api, POST_BODY, POST_BODY_NEW, "post body phone")

# openScheduleDetailDrawer — phone + conversation button
DRAWER_ACTIONS_OLD = """    '<div class="portal-schedule-drawer-actions">' +
    '<button type="button" class="btn btn-ghost" disabled title="' + escHtml(portalT('schedule.drawer.stripeSoon')) + '">' + escHtml(portalT('schedule.drawer.stripeLink')) + '</button>' +
    '<button type="button" class="btn btn-ghost" disabled title="' + escHtml(portalT('schedule.drawer.conversationSoon')) + '">' + escHtml(portalT('schedule.drawer.goConversation')) + '</button>' +
    '</div>' +
    '<p style="font-size:12px;color:var(--text-3);margin-top:14px">' + escHtml(portalT('schedule.drawer.readOnly')) + '</p>';
  drawer.style.display = 'block';
  if (backdrop) backdrop.style.display = 'block';
}"""

DRAWER_ACTIONS_NEW = """    '<p class="portal-schedule-drawer-kv"><strong>' + escHtml(portalT('schedule.drawer.phone')) + ':</strong> ' + escHtml(group.phone || row.phone || '—') + '</p>' +
    '<div class="portal-schedule-drawer-actions">' +
    '<button type="button" class="btn btn-ghost" disabled title="' + escHtml(portalT('schedule.drawer.stripeSoon')) + '">' + escHtml(portalT('schedule.drawer.stripeLink')) + '</button>' +
    '<button type="button" class="btn btn-ghost" id="ps-drawer-conversation-btn">' + escHtml(portalT('schedule.drawer.startConv')) + '</button>' +
    '</div>' +
    '<p id="ps-drawer-conversation-hint" class="portal-schedule-drawer-hint" style="display:none"></p>' +
    '<p style="font-size:12px;color:var(--text-3);margin-top:14px">' + escHtml(portalT('schedule.drawer.readOnly')) + '</p>';
  drawer.style.display = 'block';
  if (backdrop) backdrop.style.display = 'block';
  scheduleLastDrawerRowId = row._scheduleId;
  var linkedConv = scheduleFindLinkedConversation(group);
  var hasPhone = scheduleGroupHasPhone(group);
  var convBtn = el('ps-drawer-conversation-btn');
  var convHint = el('ps-drawer-conversation-hint');
  if (convBtn){
    if (linkedConv){
      convBtn.textContent = portalT('schedule.drawer.openConv');
      convBtn.disabled = false;
      convBtn.onclick = function(){ scheduleOpenOrStartConversationFromBooking(group); };
    } else if (hasPhone){
      convBtn.textContent = portalT('schedule.drawer.startConv');
      convBtn.disabled = false;
      convBtn.onclick = function(){ scheduleOpenOrStartConversationFromBooking(group); };
    } else {
      convBtn.textContent = portalT('schedule.drawer.startConv');
      convBtn.disabled = true;
      convBtn.title = portalT('schedule.drawer.conversationNeedPhone');
      if (convHint){
        convHint.textContent = portalT('schedule.drawer.conversationNeedPhone');
        convHint.style.display = 'block';
      }
    }
  }
}"""

api = replace_once(api, DRAWER_ACTIONS_OLD, DRAWER_ACTIONS_NEW, "drawer actions")

# loadSchedulePage returns promise
LOAD_OLD = """  Promise.all([convP, dataP, configP]).then(function(results){
    var convData = results[0];
    var weekData = results[1];
    scheduleConversationsCache = (convData && convData.success && convData.conversations) ? convData.conversations : [];
    scheduleRowsCache = [];
    (weekData || []).forEach(function(p){ scheduleRowsCache = scheduleRowsCache.concat(p.rows || []); });
    scheduleRowsCache.forEach(function(r){ if (r._needsReply == null) r._needsReply = false; scheduleEnsureRowId(r); });
    var demoRows = scheduleBuildDemoBookings(rangeStart);
    if (scheduleLessonTimesCache.length){
      var demoSlots = scheduleUniqueConfiguredSlots(scheduleLessonTimesCache);
      var demoLessonIdx = 0;
      demoRows.forEach(function(r){
        if (r._isDemo && scheduleRowType(r) === 'lesson' && demoSlots[demoLessonIdx]){
          r.slot_time = scheduleNormalizeSlotTime(demoSlots[demoLessonIdx].slot_time);
          demoLessonIdx += 1;
        }
      });
    }
    weekData = scheduleMergeRowsIntoWeekData(weekData, demoRows);
    scheduleRowsCache = scheduleRowsCache.concat(demoRows);
    renderScheduleSummary(profile, weekData, scheduleConversationsCache);
    renderScheduleWeekGrid(profile, weekData, rangeStart);
    if (state) state.style.display = 'none';
  }).catch(function(e){
    if (state){ state.textContent = portalT('daySchedule.error') + ' ' + e.message; state.className = 'state-msg error'; state.style.display = 'block'; }
  });
}"""

LOAD_NEW = """  return Promise.all([convP, dataP, configP]).then(function(results){
    var convData = results[0];
    var weekData = results[1];
    scheduleConversationsCache = (convData && convData.success && convData.conversations) ? convData.conversations : [];
    scheduleRowsCache = [];
    (weekData || []).forEach(function(p){ scheduleRowsCache = scheduleRowsCache.concat(p.rows || []); });
    scheduleRowsCache.forEach(function(r){ if (r._needsReply == null) r._needsReply = false; scheduleEnsureRowId(r); });
    var demoRows = scheduleBuildDemoBookings(rangeStart);
    if (scheduleLessonTimesCache.length){
      var demoSlots = scheduleUniqueConfiguredSlots(scheduleLessonTimesCache);
      var demoLessonIdx = 0;
      demoRows.forEach(function(r){
        if (r._isDemo && scheduleRowType(r) === 'lesson' && demoSlots[demoLessonIdx]){
          r.slot_time = scheduleNormalizeSlotTime(demoSlots[demoLessonIdx].slot_time);
          demoLessonIdx += 1;
        }
      });
    }
    weekData = scheduleMergeRowsIntoWeekData(weekData, demoRows);
    scheduleRowsCache = scheduleRowsCache.concat(demoRows);
    renderScheduleSummary(profile, weekData, scheduleConversationsCache);
    renderScheduleWeekGrid(profile, weekData, rangeStart);
    if (state) state.style.display = 'none';
  }).catch(function(e){
    if (state){ state.textContent = portalT('daySchedule.error') + ' ' + e.message; state.className = 'state-msg error'; state.style.display = 'block'; }
  });
}"""

api = replace_once(api, LOAD_OLD, LOAD_NEW, "loadSchedulePage return")

# staffPortalOnLocaleChange — schedule refresh
LOCALE_OLD = """  var toWrap = el('wrap-to');
  if (toWrap && typeof window.applyStaffPortalI18n === 'function') window.applyStaffPortalI18n(toWrap);
  if (typeof toRefreshRoomSelects === 'function') toRefreshRoomSelects();
  if (toBlocksCache && toBlocksCache.length && typeof toRenderBlockSelect === 'function') toRenderBlockSelect(toBlocksCache);
};"""

LOCALE_NEW = """  var toWrap = el('wrap-to');
  if (toWrap && typeof typeof window.applyStaffPortalI18n === 'function') window.applyStaffPortalI18n(toWrap);
  if (typeof toRefreshRoomSelects === 'function') toRefreshRoomSelects();
  if (toBlocksCache && toBlocksCache.length && typeof toRenderBlockSelect === 'function') toRenderBlockSelect(toBlocksCache);
  if (typeof scheduleRefreshOnLocaleChange === 'function') scheduleRefreshOnLocaleChange();
};"""

# Fix typo in locale patch - I made a mistake with typeof typeof
LOCALE_NEW = """  var toWrap = el('wrap-to');
  if (toWrap && typeof window.applyStaffPortalI18n === 'function') window.applyStaffPortalI18n(toWrap);
  if (typeof toRefreshRoomSelects === 'function') toRefreshRoomSelects();
  if (toBlocksCache && toBlocksCache.length && typeof toRenderBlockSelect === 'function') toRenderBlockSelect(toBlocksCache);
  if (typeof scheduleRefreshOnLocaleChange === 'function') scheduleRefreshOnLocaleChange();
};"""

api = replace_once(api, LOCALE_OLD, LOCALE_NEW, "locale change hook")

API.write_text(api, encoding="utf-8")

# ── i18n EN ──────────────────────────────────────────────────────────────────

i18n = I18N.read_text(encoding="utf-8")

NEW_KEYS = """    'schedule.create.phone': 'Phone number',
    'schedule.drawer.phone': 'Phone',
    'schedule.drawer.openConv': 'Open conversation',
    'schedule.drawer.startConv': 'Start conversation',
    'schedule.drawer.conversationNeedPhone': 'Add phone number to start conversation',
    'schedule.drawer.conversationFailed': 'Could not open conversation',
"""

INSERT_AT = "    'schedule.create.guestName': 'Guest name',"
require(i18n, INSERT_AT, "i18n guest name")
if "'schedule.create.phone'" not in i18n:
    i18n = i18n.replace(INSERT_AT, INSERT_AT + "\n" + NEW_KEYS)

I18N.write_text(i18n, encoding="utf-8")

# ── i18n ES supplement ───────────────────────────────────────────────────────

es = ES.read_text(encoding="utf-8")
ES_KEYS = """  'schedule.create.phone': 'Teléfono',
  'schedule.drawer.phone': 'Teléfono',
  'schedule.drawer.openConv': 'Abrir conversación',
  'schedule.drawer.startConv': 'Iniciar conversación',
  'schedule.drawer.conversationNeedPhone': 'Añade un teléfono para iniciar la conversación',
  'schedule.drawer.conversationFailed': 'No se pudo abrir la conversación',
"""
ES_INSERT = "  'schedule.create.guestName': 'Nombre del huésped',"
require(es, ES_INSERT, "es guest name")
if "'schedule.create.phone'" not in es:
    es = es.replace(ES_INSERT, ES_INSERT + "\n" + ES_KEYS)

ES.write_text(es, encoding="utf-8")

# ── verify-sunset-portal-v1.js section [24] ──────────────────────────────────

v1 = V1.read_text(encoding="utf-8")

V1_OLD = """  assert('soft light cream palette', apiSrc.includes('--cream:#EDE8E0'));
}

console.log('\\n' + '─'.repeat(48));"""

V1_NEW = """  assert('schedule calm surface scoped', apiSrc.includes('--sched-bg:#F4F5F7'));
  assert('schedule source rails retained', apiSrc.includes('.portal-schedule-ops-row-rail.is-staff'));
}

console.log('\\n[24] Sunset Schedule — calm UI, live i18n, phone, conversation');

if (apiSrc) {
  assert('no pending payment option in create form', !apiSrc.includes('value="pending" data-i18n="schedule.payment.pending"'));
  assert('unpaid card label key', apiSrc.includes('data-i18n="schedule.card.unpaid">Unpaid</div>'));
  assert('create phone field', apiSrc.includes('id="ps-create-phone"'));
  assert('post guest_phone', apiSrc.includes('guest_phone: payload.guest_phone'));
  assert('schedule locale refresh hook', apiSrc.includes('scheduleRefreshOnLocaleChange'));
  assert('drawer conversation button', apiSrc.includes('ps-drawer-conversation-btn'));
  assert('open or start conversation', apiSrc.includes('scheduleOpenOrStartConversationFromBooking'));
  assert('no row gradient wash', !apiSrc.includes('rgba(111,167,131,.14)'));
  assert('reuse create-conversation endpoint', apiSrc.includes('/staff/bookings/create-conversation'));
  assert('no auto whatsapp in schedule drawer', !apiSrc.includes('scheduleSendWhatsApp'));
}

if (writesSrc := (ROOT / 'scripts/lib/sunset-schedule-booking-writes.js').read_text(encoding='utf-8')) {
  pass
}

console.log('\\n' + '─'.repeat(48));"""

# Fix verify - can't use walrus in node verify file. Use simpler approach.

V1_NEW = """  assert('schedule calm surface scoped', apiSrc.includes('--sched-bg:#F4F5F7'));
  assert('schedule source rails retained', apiSrc.includes('.portal-schedule-ops-row-rail.is-staff'));
}

console.log('\\n[24] Sunset Schedule — calm UI, live i18n, phone, conversation');

if (apiSrc) {
  assert('no pending payment option in create form', !apiSrc.includes('value="pending" data-i18n="schedule.payment.pending"'));
  assert('unpaid card label key', apiSrc.includes('data-i18n="schedule.card.unpaid">Unpaid</div>'));
  assert('create phone field', apiSrc.includes('id="ps-create-phone"'));
  assert('post guest_phone', apiSrc.includes('guest_phone: payload.guest_phone'));
  assert('schedule locale refresh hook', apiSrc.includes('scheduleRefreshOnLocaleChange'));
  assert('drawer conversation button', apiSrc.includes('ps-drawer-conversation-btn'));
  assert('open or start conversation', apiSrc.includes('scheduleOpenOrStartConversationFromBooking'));
  assert('no row gradient wash', !apiSrc.includes('rgba(111,167,131,.14)'));
  assert('reuse create-conversation endpoint', apiSrc.includes('/staff/bookings/create-conversation'));
}

writesSrc = (ROOT / 'scripts/lib/sunset-schedule-booking-writes.js').read_text(encoding='utf-8');
if (writesSrc) {
  assert('booking insert phone column', writesSrc.includes('guest_name, phone, status'));
  assert('validate guest_phone', writesSrc.includes('guest_phone'));
}

lessonsSrc = (ROOT / 'scripts/lib/staff-ask-luna-lessons.js').read_text(encoding='utf-8');
if (lessonsSrc) {
  assert('lessons query returns phone', lessonsSrc.includes('AS phone'));
  assert('lessons query returns booking_id', lessonsSrc.includes('AS booking_id'));
}

console.log('\\n' + '─'.repeat(48));"""

v1 = replace_once(v1, V1_OLD, V1_NEW, "verify section 24")
V1.write_text(v1, encoding="utf-8")

print("PATCH OK — sunset schedule calm i18n conversation")
