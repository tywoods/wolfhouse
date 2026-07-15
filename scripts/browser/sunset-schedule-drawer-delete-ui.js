'use strict';

/**
 * Sunset Schedule drawer — booking delete controller (Slice 17).
 *
 * Injected after portal, view, edit, payment and waiver modules; before the
 * orchestration controller. Owns delete confirmation, in-flight guard,
 * stale-action protection and DELETE request lifecycle.
 *
 * Does not own drawer state, Schedule board rendering or server delete semantics.
 */

var scheduleDrawerDeleteInFlight = false;

function scheduleDrawerCanDeleteBooking(row, ctx) {
  if (!ctx || !ctx.booking_id) return false;
  if (typeof scheduleDrawerCanLoadCanonical === 'function') {
    return scheduleDrawerCanLoadCanonical(row || scheduleDrawerState.row);
  }
  return false;
}

function scheduleDrawerDeleteConfirmMessage(ctx) {
  var msg = portalT('schedule.drawer.deleteBookingConfirm');
  if (ctx && ctx.booking_code) {
    msg += ' (' + String(ctx.booking_code) + ')';
  }
  return msg;
}

function scheduleDrawerDeleteActionIsActive(openGen, bookingKey) {
  if (typeof scheduleDrawerIsRequestActive === 'function') {
    return scheduleDrawerIsRequestActive(openGen, bookingKey);
  }
  var st = scheduleDrawerState;
  if (!st || openGen !== st.openGen) return false;
  if (bookingKey && st.activeBookingKey !== bookingKey) return false;
  return true;
}

function scheduleExecuteDrawerBookingDelete(openGen, bookingKey, bookingId) {
  if (!bookingId) return;
  if (!scheduleDrawerDeleteActionIsActive(openGen, bookingKey)) return;
  if (scheduleDrawerDeleteInFlight) return;

  scheduleDrawerDeleteInFlight = true;
  var btn = el('ps-drawer-delete-booking');
  if (btn) btn.disabled = true;

  fetch('/staff/schedule/bookings?client=' + encodeURIComponent(getClient()) + sunsetLocationQuerySuffix(), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ booking_id: bookingId }),
  }).then(function(r){ return r.json().then(function(data){ return { ok: r.ok, data: data }; }); })
    .then(function(res){
      if (!scheduleDrawerDeleteActionIsActive(openGen, bookingKey)) return;
      if (!res.ok || !res.data || res.data.success !== true) {
        throw new Error((res.data && (res.data.error || res.data.message)) || 'Delete failed');
      }
      scheduleDrawerDeleteInFlight = false;
      closeScheduleDetailDrawer();
      loadSchedulePage();
    })
    .catch(function(err){
      if (!scheduleDrawerDeleteActionIsActive(openGen, bookingKey)) return;
      var m = el('ps-drawer-save-msg');
      if (m) {
        m.className = 'state-msg error';
        m.textContent = portalT('schedule.drawer.deleteBookingFailed') + ' ' + String(err && err.message ? err.message : err);
        m.style.display = 'block';
      }
      if (btn) btn.disabled = false;
      scheduleDrawerDeleteInFlight = false;
    });
}

function scheduleDeleteBookingFromDrawer(){
  var st = scheduleDrawerState;
  if (!st || !st.ctx || !st.row) return;
  if (!scheduleDrawerCanDeleteBooking(st.row, st.ctx)) return;

  var bookingId = st.ctx.booking_id;
  if (!bookingId) return;

  var openGen = st.openGen;
  var bookingKey = (typeof scheduleDrawerBookingKey === 'function')
    ? scheduleDrawerBookingKey(st.row)
    : ('id:' + String(bookingId));
  if (!scheduleDrawerDeleteActionIsActive(openGen, bookingKey)) return;
  if (scheduleDrawerDeleteInFlight) return;

  var confirmFn = (typeof window !== 'undefined' && window.confirm) ? window.confirm : null;
  if (confirmFn && !confirmFn(scheduleDrawerDeleteConfirmMessage(st.ctx))) return;
  if (!scheduleDrawerDeleteActionIsActive(openGen, bookingKey)) return;

  scheduleExecuteDrawerBookingDelete(openGen, bookingKey, bookingId);
}

function scheduleWireDrawerDeleteBooking(){
  var btn = el('ps-drawer-delete-booking');
  if (!btn) return;
  var st = scheduleDrawerState;
  if (!scheduleDrawerCanDeleteBooking(st && st.row, st && st.ctx)) {
    btn.style.display = 'none';
    return;
  }
  btn.style.display = '';
  btn.disabled = scheduleDrawerDeleteInFlight;
  btn.onclick = scheduleDeleteBookingFromDrawer;
}
