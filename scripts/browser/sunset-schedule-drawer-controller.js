'use strict';

/**
 * Sunset Schedule drawer — orchestration controller (Slice 16).
 *
 * Injected after portal, view, edit and drawer-actions. Owns drawer lifecycle:
 * open/close/refresh, loading and error states, canonical detail coordination,
 * view/edit remount, stale-response protection and child-module wiring hooks.
 *
 * Does not own edit form logic, payment/waiver/delete mutations (drawer-actions),
 * or Schedule board rendering.
 */

var scheduleDrawerState = {
  row: null,
  ctx: null,
  editing: false,
  openGen: 0,
  mountGen: 0,
  refreshGen: 0,
  activeBookingKey: null,
  prevBodyOverflow: null,
  dismissWired: false,
};

function scheduleCloneDrawerCtx(ctx){
  if (!ctx) return null;
  try { return JSON.parse(JSON.stringify(ctx)); } catch (_) { return Object.assign({}, ctx); }
}

function scheduleDrawerBookingKey(row){
  if (!row) return null;
  if (row.booking_id) return 'id:' + String(row.booking_id);
  if (row.booking_code) return 'code:' + String(row.booking_code);
  if (row._scheduleId) return 'sid:' + String(row._scheduleId);
  return null;
}

function scheduleDrawerBumpOpenGeneration(){
  scheduleDrawerState.openGen = (scheduleDrawerState.openGen || 0) + 1;
  return scheduleDrawerState.openGen;
}

function scheduleDrawerBumpMountGeneration(){
  scheduleDrawerState.mountGen = (scheduleDrawerState.mountGen || 0) + 1;
  return scheduleDrawerState.mountGen;
}

function scheduleDrawerIsRequestActive(openGen, bookingKey){
  if (openGen !== scheduleDrawerState.openGen) return false;
  if (bookingKey && scheduleDrawerState.activeBookingKey !== bookingKey) return false;
  var drawer = el('ps-detail-drawer');
  if (!drawer || drawer.style.display === 'none') return false;
  return true;
}

function scheduleDrawerEnsureDocumentLayer(){
  if (typeof document === 'undefined' || !document.body) return;
  var drawer = el('ps-detail-drawer');
  var backdrop = el('ps-drawer-backdrop');
  if (backdrop && backdrop.parentNode !== document.body) document.body.appendChild(backdrop);
  if (drawer && drawer.parentNode !== document.body) document.body.appendChild(drawer);
}

function scheduleDrawerLockPage(){
  if (typeof document === 'undefined' || !document.body) return;
  if (scheduleDrawerState.prevBodyOverflow == null) {
    scheduleDrawerState.prevBodyOverflow = document.body.style.overflow || '';
  }
  document.body.style.overflow = 'hidden';
  document.body.setAttribute('data-schedule-drawer-open', '1');
}

function scheduleDrawerUnlockPage(){
  if (typeof document === 'undefined' || !document.body) return;
  document.body.style.overflow = scheduleDrawerState.prevBodyOverflow || '';
  scheduleDrawerState.prevBodyOverflow = null;
  document.body.removeAttribute('data-schedule-drawer-open');
}

function scheduleDrawerOnBackdropClick(ev){
  var backdrop = el('ps-drawer-backdrop');
  if (!backdrop || ev.target !== backdrop) return;
  closeScheduleDetailDrawer();
}

function scheduleDrawerOnKeydown(ev){
  if (!ev || (ev.key !== 'Escape' && ev.key !== 'Esc')) return;
  var drawer = el('ps-detail-drawer');
  if (!drawer || drawer.style.display === 'none') return;
  var create = typeof el === 'function' ? el('ps-create-modal') : null;
  if (create && create.style && create.style.display && create.style.display !== 'none') return;
  if (ev.preventDefault) ev.preventDefault();
  closeScheduleDetailDrawer();
}

function scheduleDrawerWireDismiss(){
  if (scheduleDrawerState.dismissWired) return;
  scheduleDrawerState.dismissWired = true;
  var backdrop = el('ps-drawer-backdrop');
  if (backdrop && backdrop.addEventListener) backdrop.addEventListener('click', scheduleDrawerOnBackdropClick);
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('keydown', scheduleDrawerOnKeydown);
  }
}

function scheduleDrawerShowShell(){
  scheduleDrawerEnsureDocumentLayer();
  scheduleDrawerWireDismiss();
  var drawer = el('ps-detail-drawer');
  var backdrop = el('ps-drawer-backdrop');
  if (drawer) {
    // Inline display:block beats CSS display:flex. Edit form needs a flex column
    // height chain so only .portal-schedule-drawer-edit-body scrolls in-viewport.
    var editing = !!(drawer.querySelector && drawer.querySelector('#ps-drawer-edit-form'));
    drawer.style.display = editing ? 'flex' : 'block';
    drawer.style.zIndex = '9800';
  }
  if (backdrop) {
    backdrop.style.display = 'block';
    backdrop.style.zIndex = '9700';
  }
  scheduleDrawerLockPage();
}

function scheduleDrawerRenderLegacyFallback(row, group){
  var body = el('ps-drawer-body');
  if (!body) return;
  var notes = group.notes || row.notes || row.message || '';
  body.innerHTML =
    '<div class="portal-schedule-drawer-hero">' +
    '<h3 style="margin:0 0 4px;font-size:22px">' + escHtml(group.guest_name || row.guest_name || 'Guest') + '</h3>' +
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
    '';
  scheduleDrawerShowShell();
  scheduleWireDrawerConversation(row, group);
}

function scheduleWireDrawerHeaderActions(){
  var closeBtn = el('ps-drawer-close');
  if (closeBtn) closeBtn.onclick = closeScheduleDetailDrawer;
  var refreshBtn = el('ps-drawer-refresh');
  if (refreshBtn) refreshBtn.onclick = scheduleRefreshDrawer;
  var codeBtn = el('ps-drawer-copy-code');
  if (codeBtn) codeBtn.onclick = function(){
    scheduleCopyTextFallback(codeBtn.getAttribute('data-copy') || '');
    scheduleDrawerFlashCopied(codeBtn);
  };
}

function scheduleWireDrawerConversation(row, group){
  var linkedConv = scheduleFindLinkedConversation(group || row);
  var hasPhone = scheduleGroupHasPhone(group || row) || !!(el('ps-drawer-phone') && el('ps-drawer-phone').value.trim());
  var convBtn = el('ps-drawer-conversation-btn');
  var convHint = el('ps-drawer-conversation-hint');
  if (!convBtn) return;
  if (linkedConv){
    convBtn.textContent = portalT('schedule.drawer.openConv');
    convBtn.disabled = false;
    convBtn.onclick = function(){ scheduleOpenOrStartConversationFromBooking(group || row); };
  } else if (hasPhone){
    convBtn.textContent = portalT('schedule.drawer.startConv');
    convBtn.disabled = false;
    convBtn.onclick = function(){ scheduleOpenOrStartConversationFromBooking(group || row); };
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

function scheduleWireDrawerOpenCustomer(){
  var btn = el('ps-drawer-open-customer');
  if (!btn) return;
  btn.addEventListener('click', function(){
    var phone = btn.getAttribute('data-customer-phone') || '';
    if (!phone) return;
    closeScheduleDetailDrawer();
    openCustomerCardForPhone(phone);
  });
}

function scheduleWireViewDrawer(row, ctx){
  var group = scheduleFindGroupForRow(row) || row;
  scheduleWireDrawerHeaderActions();
  scheduleWireDrawerStripeCopyOpen(ctx);
  scheduleWireDrawerConversation(row, group);
  scheduleWireDrawerOpenCustomer();
  scheduleWireDrawerManualPayment(row);
  scheduleLoadDrawerWaiver(ctx);
  scheduleWireDrawerDeleteBooking();
  var editBtn = el('ps-drawer-edit');
  if (editBtn) editBtn.addEventListener('click', function(){ scheduleEnterDrawerEditMode(); });
  var stripeBtn = el('ps-drawer-stripe-link');
  if (stripeBtn) stripeBtn.addEventListener('click', function(){ scheduleCreateDrawerStripeLink(row); });
}

function scheduleMountDrawerBody(row, ctx, editing){
  var drawer = el('ps-detail-drawer');
  var backdrop = el('ps-drawer-backdrop');
  var body = el('ps-drawer-body');
  if (!drawer || !body) return;
  // Invalidate any in-flight catalog/edit callbacks from a prior mount.
  scheduleDrawerBumpMountGeneration();
  var canEdit = scheduleDrawerCanEdit(row);
  body.innerHTML = editing ? scheduleRenderEditableDrawerHtml(row, ctx) : scheduleRenderViewDrawerHtml(row, ctx, canEdit);
  scheduleDrawerShowShell();
  scheduleLastDrawerRowId = row._scheduleId;
  if (editing) scheduleWireEditableDrawer(row, ctx);
  else scheduleWireViewDrawer(row, ctx);
}

function scheduleOpenEditableDrawer(row, ctx){
  scheduleDrawerState.row = row;
  scheduleDrawerState.ctx = scheduleCloneDrawerCtx(ctx);
  scheduleDrawerState.editing = false;
  scheduleMountDrawerBody(row, scheduleDrawerState.ctx, false);
}

function scheduleRefreshDrawer(){
  var st = scheduleDrawerState;
  if (!st || !st.row) return;
  var openGen = st.openGen;
  var bookingKey = scheduleDrawerBookingKey(st.row);
  var refreshGen = (st.refreshGen || 0) + 1;
  st.refreshGen = refreshGen;
  scheduleFetchDrawerContext(st.row).then(function(data){
    if (!scheduleDrawerIsRequestActive(openGen, bookingKey)) return;
    if (st.refreshGen !== refreshGen) return;
    if (data && data.success && scheduleDrawerState && scheduleDrawerState.row){
      scheduleDrawerState.ctx = scheduleCloneDrawerCtx(data);
      scheduleMountDrawerBody(scheduleDrawerState.row, scheduleDrawerState.ctx, !!scheduleDrawerState.editing);
    }
  }).catch(function(){});
}

function openScheduleDetailDrawer(row){
  if (!row) return;
  scheduleEnsureRowId(row);
  var group = scheduleFindGroupForRow(row) || scheduleBuildDisplayGroups([row])[0] || row;
  var drawer = el('ps-detail-drawer');
  var body = el('ps-drawer-body');
  if (!drawer || !body) return;

  var openGen = scheduleDrawerBumpOpenGeneration();
  scheduleLastDrawerRowId = row._scheduleId;

  var useDrawerApi = scheduleDrawerCanLoadCanonical(row)
    || !!(row._drawerFromCustomer && (row.booking_id || row.booking_code));

  if (!useDrawerApi){
    var legacyKey = scheduleDrawerBookingKey(row);
    scheduleDrawerState.row = row;
    scheduleDrawerState.ctx = null;
    scheduleDrawerState.editing = false;
    scheduleDrawerState.activeBookingKey = legacyKey;
    scheduleDrawerRenderLegacyFallback(row, group);
    return;
  }

  body.innerHTML = scheduleRenderDrawerLoadingHtml();
  scheduleDrawerShowShell();

  var fetchRow = row._drawerFromCustomer
    ? {
      booking_id: row.booking_id || null,
      booking_code: row.booking_code || null,
      guest_name: row.guest_name || null,
      _drawerFromCustomer: true,
    }
    : Object.assign({}, row, scheduleRowBookingRef(row, group));
  var bookingKey = scheduleDrawerBookingKey(fetchRow);
  scheduleDrawerState.row = fetchRow;
  scheduleDrawerState.ctx = null;
  scheduleDrawerState.editing = false;
  scheduleDrawerState.activeBookingKey = bookingKey;

  scheduleFetchDrawerContext(fetchRow).then(function(data){
    if (!scheduleDrawerIsRequestActive(openGen, bookingKey)) return;
    if (!data || !data.success){
      body.innerHTML = scheduleRenderDrawerErrorHtml(portalT('schedule.drawer.loadFailed'), data && (data.reason_code || data.reason));
      return;
    }
    if (!scheduleDrawerIsRequestActive(openGen, bookingKey)) return;
    scheduleOpenEditableDrawer(fetchRow, data);
  }).catch(function(){
    if (!scheduleDrawerIsRequestActive(openGen, bookingKey)) return;
    body.innerHTML = scheduleRenderDrawerErrorHtml(portalT('schedule.drawer.loadFailed'));
  });
}

function closeScheduleDetailDrawer(){
  scheduleDrawerBumpOpenGeneration();
  scheduleDrawerState.row = null;
  scheduleDrawerState.ctx = null;
  scheduleDrawerState.editing = false;
  scheduleDrawerState.activeBookingKey = null;
  var drawer = el('ps-detail-drawer');
  var backdrop = el('ps-drawer-backdrop');
  if (drawer) drawer.style.display = 'none';
  if (backdrop) backdrop.style.display = 'none';
  scheduleDrawerUnlockPage();
}

if (typeof window !== 'undefined') {
  window.openScheduleDetailDrawer = openScheduleDetailDrawer;
}
