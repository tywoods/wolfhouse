'use strict';

/**
 * Sunset Schedule drawer — payment presentation + action controller (Slice 14).
 *
 * Injected after portal, view and edit modules. Owns payment section routing,
 * Stripe link create/delete, manual payment submit, copy/open wiring and
 * canonical detail refetch after successful mutations.
 *
 * Compatibility hooks (monolith): scheduleWireViewDrawer, scheduleWireEditableDrawer,
 * waiver suite, drawer open/refresh orchestration, booking delete.
 */

var scheduleDrawerStripeCreateInFlight = false;
var scheduleDrawerStripeDeleteInFlight = false;
var scheduleDrawerManualPayInFlight = false;

function scheduleDrawerPaymentFullyPaid(ctx){
  if (!ctx) return false;
  if (ctx.payment_status === 'paid') return true;
  var pay = ctx.payment || {};
  if (pay.balance_due_cents != null && Number(pay.balance_due_cents) <= 0 && Number(pay.paid_cents || 0) > 0) return true;
  return false;
}

function schedulePaymentStatusLabel(status, method){
  if (status !== 'paid') return portalT('schedule.payment.unpaid');
  if (method === 'bank_transfer') return portalT('schedule.payment.paidBankTransfer');
  if (method === 'in_store') return portalT('schedule.payment.paidInStore');
  if (method === 'link') return portalT('schedule.payment.paidViaLink');
  return portalT('schedule.payment.paid');
}

function scheduleDrawerPaymentShortUrl(ctx){
  var resolved = (typeof schedulePortalStripeLinkFromCtx === 'function')
    ? schedulePortalStripeLinkFromCtx(ctx)
    : { url: '', actionable: false };
  if (!resolved.actionable || !resolved.url) return '';
  var code = ctx && ctx.booking_code;
  if (code && typeof window !== 'undefined' && window.location && window.location.origin){
    return window.location.origin + '/pay/' + encodeURIComponent(String(code));
  }
  return resolved.url;
}

function scheduleDrawerPaymentActionableDisplayUrl(ctx){
  var resolved = (typeof schedulePortalStripeLinkFromCtx === 'function')
    ? schedulePortalStripeLinkFromCtx(ctx)
    : { url: '', actionable: false };
  if (!resolved.actionable || !resolved.url) return '';
  return scheduleDrawerPaymentShortUrl(ctx) || resolved.url;
}

function scheduleStripeStatusLabel(raw){
  var s = String(raw || '').toLowerCase();
  if (s === 'paid') return portalT('schedule.status.paid');
  if (s === 'checkout_created' || s === 'draft' || s === 'payment_link_sent' || s === '') return portalT('schedule.drawer.stripeStatusActive');
  if (s === 'expired') return portalT('schedule.drawer.stripeStatusExpired');
  return s.replace(/_/g, ' ').replace(/^\w/, function(c){ return c.toUpperCase(); });
}

function scheduleRenderDrawerPaymentSectionHtml(ctx, editable){
  if (!editable && typeof scheduleRenderDrawerPaymentSectionViewHtml === 'function') {
    return scheduleRenderDrawerPaymentSectionViewHtml(ctx);
  }
  if (editable && typeof scheduleRenderDrawerPaymentSectionEditHtml === 'function') {
    return scheduleRenderDrawerPaymentSectionEditHtml(ctx);
  }
  if (typeof scheduleRenderDrawerPaymentSectionViewHtml === 'function') {
    return scheduleRenderDrawerPaymentSectionViewHtml(ctx);
  }
  return '';
}

function scheduleRenderDrawerManualPaymentHtml(ctx){
  if (!(ctx && ctx.booking_id) || scheduleDrawerPaymentFullyPaid(ctx)) return '';
  var html = '<div id="ps-drawer-manual-pay" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border-soft)">';
  html += '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-3);margin-bottom:8px">' +
    escHtml(portalT('schedule.drawer.addManualPayment')) + '</div>';
  html += '<div class="portal-schedule-manual-pay-grid">';
  html += '<label>' + escHtml(portalT('schedule.drawer.manualPayAmount')) +
    '<input id="ps-drawer-manual-amount" type="number" min="0" step="0.01" inputmode="decimal"></label>';
  html += '<label>' + escHtml(portalT('schedule.drawer.manualPayMethod')) +
    '<select id="ps-drawer-manual-method">' +
    '<option value="bank_transfer">' + escHtml(portalT('schedule.payment.paidBankTransfer')) + '</option>' +
    '<option value="in_store">' + escHtml(portalT('schedule.payment.paidInStore')) + '</option>' +
    '</select></label>';
  html += '</div>';
  html += '<label class="portal-schedule-manual-pay-note">' + escHtml(portalT('schedule.drawer.manualPayNote')) +
    '<input id="ps-drawer-manual-note" type="text" maxlength="200"></label>';
  html += '<button type="button" class="btn btn-ghost" id="ps-drawer-manual-submit" style="margin-top:8px">' +
    escHtml(portalT('schedule.drawer.manualPaySubmit')) + '</button>';
  html += '<p id="ps-drawer-manual-msg" class="state-msg" style="display:none;margin-top:6px"></p>';
  html += '</div>';
  return html;
}

function scheduleRenderDrawerStripeLinkSectionHtml(ctx){
  var resolved = (typeof schedulePortalStripeLinkFromCtx === 'function')
    ? schedulePortalStripeLinkFromCtx(ctx)
    : { url: '', actionable: false, stale: !!(ctx && ctx.stripe_link_stale) };
  var link = ctx && ctx.stripe_link;
  var url = resolved.actionable ? resolved.url : '';
  var stale = resolved.stale || !!(ctx && (ctx.stripe_link_stale || (link && link.stale)));
  var fullyPaid = scheduleDrawerPaymentFullyPaid(ctx);
  var html = '<div id="ps-drawer-stripe-box" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border-soft)">';
  html += '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-3);margin-bottom:8px">' +
    escHtml(portalT('schedule.drawer.stripeSection')) + '</div>';
  var stripeAvail = ctx && ctx.stripe_available;
  var stripeBtnLabel = (url && !stale) ? portalT('schedule.drawer.stripeRegenerate') : portalT('schedule.drawer.stripeLink');
  if (!fullyPaid) {
    if (stripeAvail){
      html += '<button type="button" class="btn btn-ghost" id="ps-drawer-stripe-link" style="margin-bottom:10px">' + escHtml(stripeBtnLabel) + '</button>';
    } else {
      html += '<button type="button" class="btn btn-ghost" disabled title="' + escHtml(portalT('schedule.drawer.stripeUnavailable')) + '" style="margin-bottom:10px">' + escHtml(portalT('schedule.drawer.stripeLink')) + '</button>';
    }
  }
  if (stale && url){
    html += '<div class="ctx-pay-record ctx-pay-record-stale" style="margin-bottom:8px"><span class="ctx-pay-record-badge ctx-pay-record-badge-outdated">' +
      escHtml(portalT('schedule.drawer.stripeStale')) + '</span>' +
      '<div class="ctx-pay-record-stale-note">' + escHtml(portalT('schedule.drawer.stripeStaleHint')) + '</div></div>';
  }
  if (url){
    var displayUrl = scheduleDrawerPaymentActionableDisplayUrl(ctx) || url;
    html += '<p style="margin:0 0 6px"><strong>' + escHtml(portalT('schedule.drawer.stripeStatus')) + ':</strong> ' +
      escHtml(scheduleStripeStatusLabel(link && link.payment_status)) + '</p>';
    if (link && link.amount_due_cents != null){
      html += '<p style="margin:0 0 6px"><strong>' + escHtml(portalT('schedule.drawer.stripeAmount')) + ':</strong> ' +
        escHtml(scheduleDrawerEur(link.amount_due_cents)) + '</p>';
    }
    html += '<p style="margin:0 0 8px;word-break:break-all"><a id="ps-drawer-stripe-url" href="' + escHtml(displayUrl) + '" target="_blank" rel="noopener">' + escHtml(displayUrl) + '</a></p>';
    html += '<div class="portal-schedule-drawer-actions" style="margin-top:0">';
    html += '<button type="button" class="btn btn-ghost" id="ps-drawer-stripe-copy">' + escHtml(portalT('schedule.drawer.stripeCopy')) + '</button>';
    html += '<button type="button" class="btn btn-ghost portal-schedule-stripe-delete-btn" id="ps-drawer-stripe-delete">' + escHtml(portalT('schedule.drawer.stripeDelete')) + '</button>';
    html += '</div>';
  } else {
    html += '<p style="margin:0 0 8px;color:var(--text-3)">' + escHtml(portalT('schedule.drawer.stripeNone')) + '</p>';
  }
  html += '<p id="ps-drawer-stripe-msg" class="state-msg" style="display:none;margin-top:6px"></p>';
  html += '</div>';
  return html;
}

function scheduleDrawerPaymentRefetchAndRemount(row){
  var refetch = (typeof scheduleFetchDrawerContext === 'function')
    ? scheduleFetchDrawerContext(row)
    : schedulePortalFetchDrawerDetail(row);
  return refetch.then(function(detail){
    if (!detail || !detail.success) throw new Error((detail && (detail.error || detail.reason_code)) || 'Refetch failed');
    if (scheduleDrawerState && scheduleDrawerState.row){
      scheduleDrawerState.ctx = scheduleCloneDrawerCtx(detail);
      scheduleMountDrawerBody(scheduleDrawerState.row, scheduleDrawerState.ctx, !!scheduleDrawerState.editing);
    }
    return detail;
  });
}

function scheduleUpdateDrawerPaymentFromContext(ctx){
  if (!ctx || !ctx.payment) return;
  var box = el('ps-drawer-payment-box');
  if (!box) return;
  var editing = !!(scheduleDrawerState && scheduleDrawerState.editing);
  var tmp = document.createElement('div');
  tmp.innerHTML = editing
    ? scheduleRenderDrawerPaymentSectionEditHtml(ctx)
    : scheduleRenderDrawerPaymentSectionViewHtml(ctx);
  var fresh = tmp.firstChild;
  if (fresh) box.parentNode.replaceChild(fresh, box);
  scheduleWireDrawerStripeCopyOpen(ctx);
  var row = scheduleDrawerState && scheduleDrawerState.row;
  if (row) scheduleWireDrawerManualPayment(row);
}

function scheduleWireDrawerStripeCopyOpen(ctx){
  var url = scheduleDrawerPaymentActionableDisplayUrl(ctx);
  var copyBtn = el('ps-drawer-stripe-copy');
  var openBtn = el('ps-drawer-stripe-open');
  if (copyBtn && url){
    copyBtn.onclick = function(){ scheduleCopyTextFallback(url); scheduleDrawerFlashCopied(copyBtn); };
  }
  if (openBtn && url){
    openBtn.onclick = function(){ window.open(url, '_blank', 'noopener'); };
  }
  var delBtn = el('ps-drawer-stripe-delete');
  if (delBtn){ delBtn.onclick = function(){ scheduleDeleteDrawerStripeLink(ctx); }; }
}

function scheduleDeleteDrawerStripeLink(ctx){
  var bookingId = ctx && ctx.booking_id;
  if (!bookingId || scheduleDrawerStripeDeleteInFlight) return;
  if (typeof window !== 'undefined' && window.confirm && !window.confirm(portalT('schedule.drawer.stripeDeleteConfirm'))) return;
  scheduleDrawerStripeDeleteInFlight = true;
  var btn = el('ps-drawer-stripe-delete');
  if (btn) btn.disabled = true;
  var msg = el('ps-drawer-stripe-msg');
  if (msg) msg.style.display = 'none';
  fetch('/staff/schedule/bookings/stripe-link?client=' + encodeURIComponent(getClient()) + sunsetLocationQuerySuffix(), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ booking_id: bookingId }),
  }).then(function(r){ return r.json().then(function(data){ return { ok: r.ok, data: data }; }); })
    .then(function(res){
      if (!res.ok || !res.data || res.data.success !== true) throw new Error((res.data && (res.data.error || res.data.message)) || 'Delete failed');
      var row = scheduleDrawerState && scheduleDrawerState.row;
      if (!row) return;
      return scheduleDrawerPaymentRefetchAndRemount(row).then(function(){
        var m2 = el('ps-drawer-stripe-msg');
        if (m2){ m2.className = 'state-msg success'; m2.textContent = portalT('schedule.drawer.stripeDeleted'); m2.style.display = 'block'; }
      });
    })
    .catch(function(err){
      var m3 = el('ps-drawer-stripe-msg');
      if (m3){ m3.className = 'state-msg error'; m3.textContent = portalT('schedule.drawer.stripeDeleteFailed') + ' ' + err.message; m3.style.display = 'block'; }
      var b2 = el('ps-drawer-stripe-delete');
      if (b2) b2.disabled = false;
    })
    .finally(function(){ scheduleDrawerStripeDeleteInFlight = false; });
}

function scheduleCreateDrawerStripeLink(row){
  if (!row || !row.booking_id || scheduleDrawerStripeCreateInFlight) return;
  scheduleDrawerStripeCreateInFlight = true;
  var btn = el('ps-drawer-stripe-link');
  var msg = el('ps-drawer-stripe-msg');
  if (btn) btn.disabled = true;
  if (msg){ msg.style.display = 'none'; msg.textContent = ''; }
  fetch('/staff/schedule/bookings/stripe-link?client=' + encodeURIComponent(getClient()) + sunsetLocationQuerySuffix(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ booking_id: row.booking_id, idempotency_key: 'sunset-drawer-' + row.booking_id + '-' + Date.now() }),
  }).then(function(r){ return r.json().then(function(data){ return { ok: r.ok, data: data }; }); })
    .then(function(res){
      if (!res.ok || !res.data || res.data.success !== true) throw new Error((res.data && (res.data.error || res.data.message)) || 'Stripe link failed');
      return scheduleDrawerPaymentRefetchAndRemount(row);
    })
    .catch(function(err){
      if (msg){ msg.className = 'state-msg error'; msg.textContent = portalT('schedule.drawer.stripeFailed') + ' ' + err.message; msg.style.display = 'block'; }
    })
    .finally(function(){
      scheduleDrawerStripeCreateInFlight = false;
      if (btn) btn.disabled = false;
    });
}

function scheduleWireDrawerManualPayment(row){
  var btn = el('ps-drawer-manual-submit');
  if (!btn || !row || !row.booking_id) return;
  btn.addEventListener('click', function(){
    if (scheduleDrawerManualPayInFlight) return;
    var amtEl = el('ps-drawer-manual-amount');
    var methodEl = el('ps-drawer-manual-method');
    var noteEl = el('ps-drawer-manual-note');
    var msg = el('ps-drawer-manual-msg');
    var euros = parseFloat((amtEl && amtEl.value) || '');
    if (!(euros > 0)){
      if (msg){ msg.className = 'state-msg error'; msg.textContent = portalT('schedule.drawer.manualPayAmountRequired'); msg.style.display = 'block'; }
      return;
    }
    var amountCents = Math.round(euros * 100);
    scheduleDrawerManualPayInFlight = true;
    btn.disabled = true;
    if (msg) msg.style.display = 'none';
    fetch('/staff/bookings/record-cash-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_slug: getClient(),
        booking_id: row.booking_id,
        amount_cents: amountCents,
        method: (methodEl && methodEl.value) || 'cash',
        note: (noteEl && noteEl.value || '').trim() || null,
        idempotency_key: 'sunset-drawer-pay-' + row.booking_id + '-' + Date.now(),
      }),
    }).then(function(r){ return r.json().then(function(data){ return { ok: r.ok, data: data }; }); })
      .then(function(res){
        if (!res.ok || !res.data || res.data.success !== true) throw new Error((res.data && (res.data.error || res.data.message)) || 'Failed');
        if (msg){ msg.className = 'state-msg success'; msg.textContent = portalT('schedule.drawer.manualPaySaved'); msg.style.display = 'block'; }
        return scheduleDrawerPaymentRefetchAndRemount(row);
      })
      .catch(function(err){
        if (msg){ msg.className = 'state-msg error'; msg.textContent = portalT('schedule.drawer.manualPayFailed') + ' ' + err.message; msg.style.display = 'block'; }
      })
      .finally(function(){
        scheduleDrawerManualPayInFlight = false;
        btn.disabled = false;
      });
  });
}
