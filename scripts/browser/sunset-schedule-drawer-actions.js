'use strict';

/**
 * Sunset Schedule drawer — consolidated mutation actions (Slice 25).
 *
 * Injected after portal, view and edit modules; before the orchestration
 * controller. Owns Stripe-link create/delete, manual payment, waiver
 * load/create/copy, booking delete, in-flight guards, and one shared
 * authenticated JSON request helper inside a single closure.
 *
 * Rendering helpers required by view/edit compatibility are exported as
 * schedule* wrappers. Not attached to window.
 */

var SunsetScheduleDrawerActions = (function scheduleDrawerActionsFactory() {
  var flight = {
    stripeCreate: false,
    stripeDelete: false,
    manualPay: false,
    markPaid: false,
    paymentEdit: false,
    paymentVoid: false,
    waiverCreate: false,
    deleteBooking: false,
    cancelBooking: false,
    restoreBooking: false,
  };

  function requestJson(url, options) {
    var opts = options || {};
    var init = { method: opts.method || 'GET' };
    if (opts.method && opts.method !== 'GET') {
      init.headers = { 'Content-Type': 'application/json' };
    } else if (opts.headers) {
      init.headers = opts.headers;
    }
    if (opts.body !== undefined && opts.body !== null) {
      if (!init.headers) init.headers = { 'Content-Type': 'application/json' };
      init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    }
    return fetch(url, init).then(function(r) {
      return r.json().then(function(data) {
        return { ok: r.ok, status: r.status, data: data };
      }, function() {
        return { ok: r.ok, status: r.status, data: null };
      });
    });
  }

  function clientQuery() {
    return 'client=' + encodeURIComponent(getClient()) + sunsetLocationQuerySuffix();
  }

  function errorText(err) {
    return String(err && err.message ? err.message : (err || ''));
  }

  function captureIdentity(row) {
    var st = scheduleDrawerState;
    var target = row || (st && st.row) || null;
    var openGen = st ? st.openGen : -1;
    var bookingKey = (typeof scheduleDrawerBookingKey === 'function')
      ? scheduleDrawerBookingKey(target)
      : (st && st.activeBookingKey) || null;
    return { openGen: openGen, bookingKey: bookingKey, row: target };
  }

  function actionIsActive(identity) {
    if (!identity) return false;
    if (typeof scheduleDrawerIsRequestActive === 'function') {
      return scheduleDrawerIsRequestActive(identity.openGen, identity.bookingKey);
    }
    var st = scheduleDrawerState;
    if (!st || identity.openGen !== st.openGen) return false;
    if (identity.bookingKey && st.activeBookingKey !== identity.bookingKey) return false;
    return true;
  }

  // ── Payment presentation ───────────────────────────────────────────────

  function paymentFullyPaid(ctx) {
    if (!ctx) return false;
    if (ctx.payment_status === 'paid') return true;
    var pay = ctx.payment || {};
    if (pay.balance_due_cents != null && Number(pay.balance_due_cents) <= 0 && Number(pay.paid_cents || 0) > 0) return true;
    return false;
  }

  function paymentStatusLabel(status, method) {
    if (status !== 'paid') return portalT('schedule.payment.unpaid');
    if (method === 'bank_transfer') return portalT('schedule.payment.paidBankTransfer');
    if (method === 'in_store') return portalT('schedule.payment.paidInStore');
    if (method === 'link') return portalT('schedule.payment.paidViaLink');
    return portalT('schedule.payment.paid');
  }

  function paymentShortUrl(ctx) {
    var resolved = (typeof schedulePortalStripeLinkFromCtx === 'function')
      ? schedulePortalStripeLinkFromCtx(ctx)
      : { url: '', actionable: false };
    if (!resolved.actionable || !resolved.url) return '';
    var code = ctx && ctx.booking_code;
    if (code && typeof window !== 'undefined' && window.location && window.location.origin) {
      return window.location.origin + '/pay/' + encodeURIComponent(String(code));
    }
    return resolved.url;
  }

  function paymentActionableDisplayUrl(ctx) {
    var resolved = (typeof schedulePortalStripeLinkFromCtx === 'function')
      ? schedulePortalStripeLinkFromCtx(ctx)
      : { url: '', actionable: false };
    if (!resolved.actionable || !resolved.url) return '';
    return paymentShortUrl(ctx) || resolved.url;
  }

  function stripeStatusLabel(raw) {
    var s = String(raw || '').toLowerCase();
    if (s === 'paid') return portalT('schedule.status.paid');
    if (s === 'checkout_created' || s === 'draft' || s === 'payment_link_sent' || s === '') return portalT('schedule.drawer.stripeStatusActive');
    if (s === 'expired') return portalT('schedule.drawer.stripeStatusExpired');
    return s.replace(/_/g, ' ').replace(/^\w/, function(c) { return c.toUpperCase(); });
  }

  function renderPaymentSectionHtml(ctx, editable) {
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

  function renderManualPaymentHtml(ctx) {
    if (!(ctx && ctx.booking_id) || paymentFullyPaid(ctx)) return '';
    var due = ctx.payment && ctx.payment.balance_due_cents != null ? Number(ctx.payment.balance_due_cents) : null;
    var defaultEur = (due > 0) ? (due / 100).toFixed(2) : '';
    var html = '<div id="ps-drawer-manual-pay" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border-soft)">';
    html += '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-3);margin-bottom:8px">' +
      escHtml(portalT('schedule.drawer.addManualPayment')) + '</div>';
    html += '<div class="portal-schedule-manual-pay-grid">';
    html += '<label>' + escHtml(portalT('schedule.drawer.manualPayAmount')) +
      '<input id="ps-drawer-manual-amount" type="number" min="0" step="0.01" inputmode="decimal"' +
      (defaultEur ? (' value="' + escHtml(defaultEur) + '"') : '') + '></label>';
    html += '<label>' + escHtml(portalT('schedule.drawer.manualPayMethod')) +
      '<select id="ps-drawer-manual-method">' +
      '<option value="bank_transfer">' + escHtml(portalT('schedule.payment.paidBankTransfer')) + '</option>' +
      '<option value="in_store">' + escHtml(portalT('schedule.payment.paidInStore')) + '</option>' +
      '<option value="link">' + escHtml(portalT('schedule.payment.paidViaLink')) + '</option>' +
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

  function renderStripeLinkSectionHtml(ctx) {
    var resolved = (typeof schedulePortalStripeLinkFromCtx === 'function')
      ? schedulePortalStripeLinkFromCtx(ctx)
      : { url: '', actionable: false, stale: !!(ctx && ctx.stripe_link_stale) };
    var link = ctx && ctx.stripe_link;
    var url = resolved.actionable ? resolved.url : '';
    var stale = resolved.stale || !!(ctx && (ctx.stripe_link_stale || (link && link.stale)));
    var fullyPaid = paymentFullyPaid(ctx);
    var html = '<div id="ps-drawer-stripe-box" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border-soft)">';
    html += '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-3);margin-bottom:8px">' +
      escHtml(portalT('schedule.drawer.stripeSection')) + '</div>';
    var stripeAvail = ctx && ctx.stripe_available;
    var stripeBtnLabel = stale ? portalT('schedule.drawer.createNewPaymentLink')
      : ((url && !stale) ? portalT('schedule.drawer.stripeRegenerate') : portalT('schedule.drawer.stripeLink'));
    if (!fullyPaid) {
      if (stripeAvail) {
        html += '<button type="button" class="btn btn-ghost" id="ps-drawer-stripe-link" style="margin-bottom:10px">' + escHtml(stripeBtnLabel) + '</button>';
      } else {
        html += '<button type="button" class="btn btn-ghost" disabled title="' + escHtml(portalT('schedule.drawer.stripeUnavailable')) + '" style="margin-bottom:10px">' + escHtml(portalT('schedule.drawer.stripeLink')) + '</button>';
      }
    }
    if (stale && url) {
      html += '<div class="ctx-pay-record ctx-pay-record-stale" style="margin-bottom:8px"><span class="ctx-pay-record-badge ctx-pay-record-badge-outdated">' +
        escHtml(portalT('schedule.drawer.stripeStale')) + '</span>' +
        '<div class="ctx-pay-record-stale-note">' + escHtml(portalT('schedule.drawer.stripeStaleHint')) + '</div></div>';
    }
    if (url) {
      var displayUrl = paymentActionableDisplayUrl(ctx) || url;
      html += '<p style="margin:0 0 6px"><strong>' + escHtml(portalT('schedule.drawer.stripeStatus')) + ':</strong> ' +
        escHtml(stripeStatusLabel(link && link.payment_status)) + '</p>';
      if (link && link.amount_due_cents != null) {
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

  function paymentRefetchAndRemount(row, identity) {
    var refetch = (typeof scheduleFetchDrawerContext === 'function')
      ? scheduleFetchDrawerContext(row)
      : schedulePortalFetchDrawerDetail(row);
    return refetch.then(function(detail) {
      if (identity && !actionIsActive(identity)) return detail;
      if (!detail || !detail.success) throw new Error((detail && (detail.error || detail.reason_code)) || 'Refetch failed');
      if (scheduleDrawerState && scheduleDrawerState.row) {
        scheduleDrawerState.ctx = scheduleCloneDrawerCtx(detail);
        scheduleMountDrawerBody(scheduleDrawerState.row, scheduleDrawerState.ctx, !!scheduleDrawerState.editing);
      }
      return detail;
    });
  }

  function updatePaymentFromContext(ctx) {
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
    wireStripeCopyOpen(ctx);
    var row = scheduleDrawerState && scheduleDrawerState.row;
    if (row) {
      wireManualPayment(row);
      wireMarkAsPaid(row, ctx);
      wirePaymentLedgerEdits(row, ctx);
    }
  }

  function wireStripeCopyOpen(ctx) {
    var url = paymentActionableDisplayUrl(ctx);
    var copyBtn = el('ps-drawer-stripe-copy');
    var openBtn = el('ps-drawer-stripe-open');
    if (copyBtn && url) {
      copyBtn.onclick = function() { scheduleCopyTextFallback(url); scheduleDrawerFlashCopied(copyBtn); };
    }
    if (openBtn && url) {
      openBtn.onclick = function() { window.open(url, '_blank', 'noopener'); };
    }
    var delBtn = el('ps-drawer-stripe-delete');
    if (delBtn) { delBtn.onclick = function() { deleteStripeLink(ctx); }; }
  }

  function deleteStripeLink(ctx) {
    var bookingId = ctx && ctx.booking_id;
    if (!bookingId || flight.stripeDelete) return;
    var identity = captureIdentity();
    if (!actionIsActive(identity)) return;
    if (typeof window !== 'undefined' && window.confirm && !window.confirm(portalT('schedule.drawer.stripeDeleteConfirm'))) return;
    if (!actionIsActive(identity)) return;
    flight.stripeDelete = true;
    var btn = el('ps-drawer-stripe-delete');
    if (btn) btn.disabled = true;
    var msg = el('ps-drawer-stripe-msg');
    if (msg) msg.style.display = 'none';
    requestJson('/staff/schedule/bookings/stripe-link?' + clientQuery(), {
      method: 'DELETE',
      body: { booking_id: bookingId },
    }).then(function(res) {
      if (!actionIsActive(identity)) return;
      if (!res.ok || !res.data || res.data.success !== true) throw new Error((res.data && (res.data.error || res.data.message)) || 'Delete failed');
      var row = scheduleDrawerState && scheduleDrawerState.row;
      if (!row) return;
      return paymentRefetchAndRemount(row, identity).then(function() {
        if (!actionIsActive(identity)) return;
        var m2 = el('ps-drawer-stripe-msg');
        if (m2) { m2.className = 'state-msg success'; m2.textContent = portalT('schedule.drawer.stripeDeleted'); m2.style.display = 'block'; }
      });
    }).catch(function(err) {
      if (!actionIsActive(identity)) return;
      var m3 = el('ps-drawer-stripe-msg');
      if (m3) { m3.className = 'state-msg error'; m3.textContent = portalT('schedule.drawer.stripeDeleteFailed') + ' ' + errorText(err); m3.style.display = 'block'; }
      var b2 = el('ps-drawer-stripe-delete');
      if (b2) b2.disabled = false;
    }).finally(function() { flight.stripeDelete = false; });
  }

  function createStripeLink(row) {
    if (!row || !row.booking_id || flight.stripeCreate) return;
    var identity = captureIdentity(row);
    if (!actionIsActive(identity)) return;
    flight.stripeCreate = true;
    var btn = el('ps-drawer-stripe-link');
    var msg = el('ps-drawer-stripe-msg');
    if (btn) btn.disabled = true;
    if (msg) { msg.style.display = 'none'; msg.textContent = ''; }
    requestJson('/staff/schedule/bookings/stripe-link?' + clientQuery(), {
      method: 'POST',
      body: { booking_id: row.booking_id, idempotency_key: 'sunset-drawer-' + row.booking_id + '-' + Date.now() },
    }).then(function(res) {
      if (!actionIsActive(identity)) return;
      if (!res.ok || !res.data || res.data.success !== true) throw new Error((res.data && (res.data.error || res.data.message)) || 'Stripe link failed');
      return paymentRefetchAndRemount(row, identity);
    }).catch(function(err) {
      if (!actionIsActive(identity)) return;
      if (msg) { msg.className = 'state-msg error'; msg.textContent = portalT('schedule.drawer.stripeFailed') + ' ' + errorText(err); msg.style.display = 'block'; }
    }).finally(function() {
      flight.stripeCreate = false;
      if (btn) btn.disabled = false;
    });
  }

  function wireManualPayment(row) {
    var btn = el('ps-drawer-manual-submit');
    var ctx = (scheduleDrawerState && scheduleDrawerState.ctx) || null;
    if (btn && row && row.booking_id) {
      btn.onclick = function() {
        if (flight.manualPay) return;
        var identity = captureIdentity(row);
        if (!actionIsActive(identity)) return;
        var amtEl = el('ps-drawer-manual-amount');
        var methodEl = el('ps-drawer-manual-method');
        var noteEl = el('ps-drawer-manual-note');
        var msg = el('ps-drawer-manual-msg');
        var euros = parseFloat((amtEl && amtEl.value) || '');
        if (!(euros > 0)) {
          if (msg) { msg.className = 'state-msg error'; msg.textContent = portalT('schedule.drawer.manualPayAmountRequired'); msg.style.display = 'block'; }
          return;
        }
        var amountCents = Math.round(euros * 100);
        flight.manualPay = true;
        btn.disabled = true;
        if (msg) msg.style.display = 'none';
        requestJson('/staff/bookings/record-cash-payment', {
          method: 'POST',
          body: {
            client_slug: getClient(),
            booking_id: row.booking_id,
            amount_cents: amountCents,
            method: (methodEl && methodEl.value) || 'bank_transfer',
            note: (noteEl && noteEl.value || '').trim() || null,
            idempotency_key: 'sunset-drawer-pay-' + row.booking_id + '-' + Date.now(),
          },
        }).then(function(res) {
          if (!actionIsActive(identity)) return;
          if (!res.ok || !res.data || res.data.success !== true) throw new Error((res.data && (res.data.error || res.data.message)) || 'Failed');
          if (msg) { msg.className = 'state-msg success'; msg.textContent = portalT('schedule.drawer.manualPaySaved'); msg.style.display = 'block'; }
          return paymentRefetchAndRemount(row, identity);
        }).catch(function(err) {
          if (!actionIsActive(identity)) return;
          if (msg) { msg.className = 'state-msg error'; msg.textContent = portalT('schedule.drawer.manualPayFailed') + ' ' + errorText(err); msg.style.display = 'block'; }
        }).finally(function() {
          flight.manualPay = false;
          btn.disabled = false;
        });
      };
    }
    wireMarkAsPaid(row, ctx);
    wirePaymentLedgerEdits(row, ctx);
  }

  function wireMarkAsPaid(row, ctx) {
    var btn = el('ps-drawer-mark-paid');
    if (!btn || !row || !row.booking_id) return;
    btn.onclick = function() {
      if (flight.markPaid) return;
      var identity = captureIdentity(row);
      if (!actionIsActive(identity)) return;
      var methodEl = el('ps-drawer-mark-paid-method') || el('ps-drawer-manual-method');
      var msg = el('ps-drawer-manual-msg');
      flight.markPaid = true;
      btn.disabled = true;
      if (msg) msg.style.display = 'none';
      requestJson('/staff/bookings/record-cash-payment', {
        method: 'POST',
        body: {
          client_slug: getClient(),
          booking_id: row.booking_id,
          mark_paid: true,
          method: (methodEl && methodEl.value) || 'bank_transfer',
          idempotency_key: 'sunset-drawer-mark-paid-' + row.booking_id + '-' + Date.now(),
        },
      }).then(function(res) {
        if (!actionIsActive(identity)) return;
        if (!res.ok || !res.data || res.data.success !== true) throw new Error((res.data && (res.data.error || res.data.message)) || 'Failed');
        if (msg) { msg.className = 'state-msg success'; msg.textContent = portalT('schedule.drawer.markAsPaidSaved'); msg.style.display = 'block'; }
        return paymentRefetchAndRemount(row, identity);
      }).catch(function(err) {
        if (!actionIsActive(identity)) return;
        if (msg) { msg.className = 'state-msg error'; msg.textContent = portalT('schedule.drawer.markAsPaidFailed') + ' ' + errorText(err); msg.style.display = 'block'; }
      }).finally(function() {
        flight.markPaid = false;
        btn.disabled = false;
      });
    };
  }

  function wirePaymentLedgerEdits(row, ctx) {
    var box = el('ps-drawer-payment-box');
    if (!box || !row || !row.booking_id) return;
    var voidBtns = box.querySelectorAll('.ps-payment-void-btn');
    Array.prototype.forEach.call(voidBtns, function(btn) {
      btn.onclick = function() {
        if (flight.paymentVoid) return;
        var paymentId = btn.getAttribute('data-payment-id');
        if (!paymentId) return;
        var identity = captureIdentity(row);
        if (!actionIsActive(identity)) return;
        if (typeof window !== 'undefined' && window.confirm && !window.confirm(portalT('schedule.drawer.voidPaymentConfirm'))) return;
        if (!actionIsActive(identity)) return;
        flight.paymentVoid = true;
        btn.disabled = true;
        requestJson('/staff/bookings/void-manual-payment', {
          method: 'POST',
          body: {
            client_slug: getClient(),
            booking_id: row.booking_id,
            payment_id: paymentId,
            idempotency_key: 'sunset-drawer-void-' + paymentId + '-' + Date.now(),
          },
        }).then(function(res) {
          if (!actionIsActive(identity)) return;
          if (!res.ok || !res.data || res.data.success !== true) throw new Error((res.data && (res.data.error || res.data.message)) || 'Failed');
          return paymentRefetchAndRemount(row, identity);
        }).catch(function(err) {
          if (!actionIsActive(identity)) return;
          var msg = el('ps-drawer-manual-msg') || el('ps-drawer-stripe-msg');
          if (msg) { msg.className = 'state-msg error'; msg.textContent = portalT('schedule.drawer.voidPaymentFailed') + ' ' + errorText(err); msg.style.display = 'block'; }
          btn.disabled = false;
        }).finally(function() { flight.paymentVoid = false; });
      };
    });
    var editBtns = box.querySelectorAll('.ps-payment-edit-btn');
    Array.prototype.forEach.call(editBtns, function(btn) {
      btn.onclick = function() {
        if (flight.paymentEdit) return;
        var paymentId = btn.getAttribute('data-payment-id');
        if (!paymentId) return;
        var block = btn.closest ? btn.closest('.ps-invoice-credit-block') : null;
        var amtCents = block ? Number(block.getAttribute('data-amount-cents') || 0) : 0;
        var method = block ? String(block.getAttribute('data-method') || 'bank_transfer') : 'bank_transfer';
        var eurosDefault = amtCents > 0 ? (amtCents / 100).toFixed(2) : '';
        var eurosRaw = (typeof window !== 'undefined' && window.prompt)
          ? window.prompt(portalT('schedule.drawer.editPaymentAmountPrompt'), eurosDefault)
          : eurosDefault;
        if (eurosRaw == null) return;
        var euros = parseFloat(String(eurosRaw).replace(',', '.'));
        if (!(euros > 0)) return;
        var methodRaw = (typeof window !== 'undefined' && window.prompt)
          ? window.prompt(portalT('schedule.drawer.editPaymentMethodPrompt'), method)
          : method;
        if (methodRaw == null) return;
        var nextMethod = String(methodRaw || '').trim().toLowerCase();
        if (nextMethod === 'stripe' || nextMethod === 'card' || nextMethod === 'paid_via_link') nextMethod = 'link';
        if (nextMethod === 'cash' || nextMethod === 'paid_in_store') nextMethod = 'in_store';
        if (nextMethod === 'paid_bank_transfer') nextMethod = 'bank_transfer';
        if (nextMethod !== 'link' && nextMethod !== 'bank_transfer' && nextMethod !== 'in_store') return;
        var identity = captureIdentity(row);
        if (!actionIsActive(identity)) return;
        flight.paymentEdit = true;
        btn.disabled = true;
        requestJson('/staff/bookings/update-manual-payment', {
          method: 'POST',
          body: {
            client_slug: getClient(),
            booking_id: row.booking_id,
            payment_id: paymentId,
            amount_cents: Math.round(euros * 100),
            method: nextMethod,
            idempotency_key: 'sunset-drawer-edit-' + paymentId + '-' + Date.now(),
          },
        }).then(function(res) {
          if (!actionIsActive(identity)) return;
          if (!res.ok || !res.data || res.data.success !== true) throw new Error((res.data && (res.data.error || res.data.message)) || 'Failed');
          return paymentRefetchAndRemount(row, identity);
        }).catch(function(err) {
          if (!actionIsActive(identity)) return;
          var msg = el('ps-drawer-manual-msg') || el('ps-drawer-stripe-msg');
          if (msg) { msg.className = 'state-msg error'; msg.textContent = portalT('schedule.drawer.editPaymentFailed') + ' ' + errorText(err); msg.style.display = 'block'; }
          btn.disabled = false;
        }).finally(function() { flight.paymentEdit = false; });
      };
    });
  }

  // ── Waiver ─────────────────────────────────────────────────────────────

  function waiverStatusLabel(status) {
    if (status === 'pending') return portalT('schedule.drawer.waiverPending');
    if (status === 'completed') return portalT('schedule.drawer.waiverCompleted');
    if (status === 'needs_review') return portalT('schedule.drawer.waiverNeedsReview');
    if (status === 'expired') return portalT('schedule.drawer.waiverExpired');
    if (status === 'revoked') return portalT('schedule.drawer.waiverRevoked');
    return status || '—';
  }

  function waiverIsGroup(data) {
    var w = data && data.waiver;
    var guestCount = Number(data && data.guest_count) || 1;
    if (w && w.request_mode === 'group') return true;
    if (data && data.expected_request_mode === 'group') return true;
    return guestCount > 1;
  }

  function waiverTargetCount(data) {
    var w = data && data.waiver;
    if (w && w.target_count != null) return Number(w.target_count);
    if (data && data.target_count != null) return Number(data.target_count);
    var guestCount = Number(data && data.guest_count) || 1;
    return guestCount > 1 ? guestCount : null;
  }

  function waiverCompletedCount(data) {
    var w = data && data.waiver;
    if (w && w.completed_count != null) return Number(w.completed_count);
    if (data && data.completed_count != null) return Number(data.completed_count);
    return 0;
  }

  function waiverRemountFromData(data) {
    var box = el('ps-drawer-waiver-box');
    if (!box) return;
    box.innerHTML = renderWaiverBoxInner(data);
    wireWaiver(data);
  }

  function renderWaiverBoxInner(data) {
    var html = '';
    var isGroup = waiverIsGroup(data);
    if (data && data.migration_pending) {
      html += '<p class="portal-schedule-drawer-hint" style="margin:0">' + escHtml(portalT('schedule.drawer.waiverMigrationPending')) + '</p>';
      return html;
    }
    var w = data && data.waiver;
    var targetCount = waiverTargetCount(data);
    var completedCount = waiverCompletedCount(data);
    if (isGroup) {
      // Localized share hint — never render server multi_student_note (locale leak).
      html += '<p class="portal-schedule-drawer-hint" style="margin:0 0 8px">' + escHtml(portalT('schedule.drawer.waiverGroupShareHint')) + '</p>';
      html += '<p class="portal-schedule-drawer-kv" style="margin:0 0 6px"><strong>' + escHtml(portalT('schedule.drawer.waiverGroupLabel')) + ':</strong> ' + escHtml(String(targetCount || (data && data.guest_count) || '—')) + ' ' + escHtml(portalT('schedule.drawer.waiverStudents')) + '</p>';
      if (targetCount != null && targetCount > 0) {
        var pct = Math.max(0, Math.min(100, Math.round((completedCount / targetCount) * 100)));
        var complete = completedCount >= targetCount;
        html += '<div class="ps-reg-progress"><div class="ps-reg-progress-bar' + (complete ? ' is-complete' : '') + '" style="width:' + pct + '%"></div></div>';
        html += '<p class="portal-schedule-drawer-kv" style="margin:0 0 10px"><strong>' + escHtml(portalT('schedule.drawer.waiverCompletedProgress')) + ':</strong> ' + escHtml(String(completedCount) + ' / ' + String(targetCount)) + '</p>';
      } else if (completedCount > 0) {
        html += '<p class="portal-schedule-drawer-kv" style="margin:0 0 10px"><strong>' + escHtml(portalT('schedule.drawer.waiverCompletedProgress')) + ':</strong> ' + escHtml(String(completedCount)) + '</p>';
      }
    }
    if (!w) {
      if (!isGroup) {
        html += '<p class="portal-schedule-drawer-kv" style="margin:0 0 10px">' + escHtml(portalT('schedule.drawer.waiverNone')) + '</p>';
      }
      var createLabel = isGroup ? portalT('schedule.drawer.waiverCreateGroup') : portalT('schedule.drawer.waiverCreate');
      html += '<button type="button" class="btn btn-primary" id="ps-drawer-waiver-create">' + escHtml(createLabel) + '</button>';
      html += '<p id="ps-drawer-waiver-msg" class="state-msg" style="display:none;margin-top:8px"></p>';
      return html;
    }
    html += '<p class="portal-schedule-drawer-kv"><strong>' + escHtml(portalT('schedule.drawer.waiverStatus')) + ':</strong> ' + escHtml(waiverStatusLabel(w.status)) + '</p>';
    if (w.status === 'completed' && w.completed_at) {
      html += '<p class="portal-schedule-drawer-kv"><strong>' + escHtml(portalT('schedule.drawer.waiverCompletedAt')) + ':</strong> ' + escHtml(scheduleDateOnlyLabel(w.completed_at)) + '</p>';
    }
    var showAnswers = isGroup ? completedCount > 0 : w.status === 'completed';
    if (w.public_url) {
      var copyLabelKey = isGroup ? 'schedule.drawer.waiverCopyGroup' : 'schedule.drawer.waiverCopy';
      html += '<div class="ps-money-link-row"><a id="ps-drawer-waiver-url" href="' + escHtml(w.public_url) + '" target="_blank" rel="noopener" class="ps-money-link-a">' + escHtml(w.public_url) + '</a>' + scheduleDrawerCopyIconBtnHtml('ps-drawer-waiver-copy', copyLabelKey) + '</div>';
      if (showAnswers) {
        html += '<div class="portal-schedule-drawer-actions" style="margin-top:8px"><button type="button" class="btn btn-ghost" id="ps-drawer-waiver-view">' + escHtml(portalT('schedule.drawer.waiverViewAnswers')) + '</button></div>';
      }
    } else if (w.status === 'pending' || w.status === 'needs_review') {
      var retryLabel = isGroup ? portalT('schedule.drawer.waiverCreateGroup') : portalT('schedule.drawer.waiverCreate');
      html += '<button type="button" class="btn btn-primary" id="ps-drawer-waiver-create">' + escHtml(retryLabel) + '</button>';
    }
    html += '<div id="ps-drawer-waiver-answers" style="display:none;margin-top:10px"></div>';
    html += '<p id="ps-drawer-waiver-msg" class="state-msg" style="display:none;margin-top:8px"></p>';
    return html;
  }

  function wireWaiver(data) {
    var createBtn = el('ps-drawer-waiver-create');
    if (createBtn) {
      createBtn.onclick = function() { createWaiver(); };
    }
    var copyBtn = el('ps-drawer-waiver-copy');
    var url = data && data.waiver && data.waiver.public_url;
    if (copyBtn && url) {
      copyBtn.onclick = function() { scheduleCopyTextFallback(url); scheduleDrawerFlashCopied(copyBtn); };
    }
    var viewBtn = el('ps-drawer-waiver-view');
    if (viewBtn) {
      viewBtn.onclick = function() { viewWaiverAnswers(data); };
    }
  }

  function viewWaiverAnswers(data) {
    var box = el('ps-drawer-waiver-answers');
    if (!box) return;
    var w = data && data.waiver;
    var isGroup = waiverIsGroup(data);
    var completedCount = waiverCompletedCount(data);
    var sub = w && w.submission;
    if (!isGroup && sub) {
      renderWaiverAnswers(sub);
      return;
    }
    if (isGroup && completedCount < 1) return;
    var bookingId = scheduleDrawerState && scheduleDrawerState.ctx && scheduleDrawerState.ctx.booking_id;
    if (!bookingId) return;
    var identity = captureIdentity();
    requestJson('/staff/schedule/bookings/' + encodeURIComponent(bookingId) + '/waiver/submission?' + clientQuery())
      .then(function(res) {
        if (!actionIsActive(identity)) return;
        var payload = res.data;
        if (!payload || !payload.success) throw new Error((payload && payload.error) || 'No submission');
        if (payload.submissions && payload.submissions.length) {
          renderWaiverAnswers(payload);
        } else if (payload.submission) {
          renderWaiverAnswers(payload.submission);
        } else {
          throw new Error('No submission');
        }
      })
      .catch(function(err) {
        if (!actionIsActive(identity)) return;
        var m = el('ps-drawer-waiver-msg');
        if (m) { m.className = 'state-msg error'; m.textContent = errorText(err); m.style.display = 'block'; }
      });
  }

  function renderWaiverSubmissionBlock(sub) {
    var answers = (sub.raw_answers_json && sub.raw_answers_json.answers) || sub.raw_answers_json || {};
    var html = '';
    Object.keys(answers).forEach(function(key) {
      var a = answers[key];
      if (!a || typeof a !== 'object') return;
      var val = a.value;
      if (val && typeof val === 'object') {
        if (Array.isArray(val)) val = val.join(', ');
        else if (val.option_label) val = val.option_label;
        else val = JSON.stringify(val);
      }
      if (val === true) val = 'Sí';
      if (val === false) val = '—';
      html += '<p class="portal-schedule-drawer-kv" style="margin:6px 0 0"><strong>' + escHtml(a.label || key) + ':</strong> ' + escHtml(String(val == null ? '—' : val)) + '</p>';
    });
    return html;
  }

  function renderWaiverAnswers(payload) {
    var box = el('ps-drawer-waiver-answers');
    if (!box) return;
    var subs = [];
    if (payload && payload.submissions && payload.submissions.length) {
      subs = payload.submissions;
    } else if (Array.isArray(payload)) {
      subs = payload;
    } else if (payload) {
      subs = [payload];
    }
    var html = '<div style="font-size:12px;border-top:1px solid var(--border-soft);padding-top:8px">';
    html += '<strong>' + escHtml(portalT('schedule.drawer.waiverAnswers')) + '</strong>';
    subs.forEach(function(sub, idx) {
      if (subs.length > 1) {
        html += '<div style="margin-top:12px;padding-top:8px;border-top:1px solid var(--border-soft)">';
        html += '<p class="portal-schedule-drawer-kv" style="margin:0 0 4px"><strong>' + escHtml(portalT('schedule.drawer.waiverStudentLabel')) + ' ' + (idx + 1);
        if (sub.respondent_name) html += ': ' + escHtml(sub.respondent_name);
        html += '</strong></p>';
        if (sub.submitted_at) {
          html += '<p class="portal-schedule-drawer-kv" style="margin:0 0 6px;color:var(--text-muted)">' + escHtml(scheduleDateOnlyLabel(sub.submitted_at)) + '</p>';
        }
      }
      html += renderWaiverSubmissionBlock(sub);
      if (subs.length > 1) html += '</div>';
    });
    html += '</div>';
    box.innerHTML = html;
    box.style.display = 'block';
  }

  function loadWaiver(ctx) {
    var box = el('ps-drawer-waiver-box');
    if (!box || !(ctx && ctx.booking_id) || getClient() !== 'sunset') return Promise.resolve();
    var identity = captureIdentity();
    return requestJson('/staff/schedule/bookings/' + encodeURIComponent(ctx.booking_id) + '/waiver?' + clientQuery())
      .then(function(res) {
        if (!actionIsActive(identity)) return;
        if (!box) return;
        waiverRemountFromData(res.data);
      })
      .catch(function(err) {
        if (!actionIsActive(identity)) return;
        if (!box) return;
        box.innerHTML = '<p class="state-msg error" style="margin:0">' + escHtml(portalT('schedule.drawer.waiverLoadFailed')) + ' ' + escHtml(errorText(err)) + '</p>';
      });
  }

  function createWaiver() {
    if (flight.waiverCreate) return;
    var ctx = scheduleDrawerState && scheduleDrawerState.ctx;
    var bookingId = ctx && ctx.booking_id;
    if (!bookingId) return;
    var identity = captureIdentity();
    if (!actionIsActive(identity)) return;
    flight.waiverCreate = true;
    var btn = el('ps-drawer-waiver-create');
    if (btn) btn.disabled = true;
    var msg = el('ps-drawer-waiver-msg');
    if (msg) { msg.style.display = 'none'; msg.textContent = ''; }
    requestJson('/staff/schedule/bookings/' + encodeURIComponent(bookingId) + '/waiver?' + clientQuery(), {
      method: 'POST',
      body: {},
    }).then(function(res) {
      if (!actionIsActive(identity)) return;
      if (!res.ok || !res.data || res.data.success !== true) {
        throw new Error((res.data && (res.data.error || res.data.message)) || 'Create failed');
      }
      return loadWaiver(ctx).then(function() {
        if (!actionIsActive(identity)) return;
        var m = el('ps-drawer-waiver-msg');
        if (m) { m.className = 'state-msg success'; m.textContent = portalT('schedule.drawer.waiverCreated'); m.style.display = 'block'; }
      });
    }).catch(function(err) {
      if (!actionIsActive(identity)) return;
      var m = el('ps-drawer-waiver-msg');
      if (m) { m.className = 'state-msg error'; m.textContent = portalT('schedule.drawer.waiverCreateFailed') + ' ' + errorText(err); m.style.display = 'block'; }
      if (btn) btn.disabled = false;
    }).finally(function() { flight.waiverCreate = false; });
  }

  // ── Cancel / remove-from-schedule ─────────────────────────────────────

  function bookingIsCancelled(ctx, row) {
    var st = String(
      (ctx && (ctx.booking_status || ctx.bookingStatus))
      || (row && (row.booking_status || row.bookingStatus))
      || ''
    ).toLowerCase();
    if (st === 'cancelled' || st === 'canceled') return true;
    if (ctx && (ctx.schedule_ghost === true || ctx.schedule_ghost === 'true')) return true;
    if (row && (row.schedule_ghost === true || row.schedule_ghost === 'true' || row._isCancelled === true)) return true;
    return false;
  }

  function hasCapturedMoney(ctx) {
    if (paymentFullyPaid(ctx)) return true;
    if (!ctx) return false;
    var pay = ctx.payment || {};
    var paid = Number(pay.paid_cents != null ? pay.paid_cents : (ctx.amount_paid_cents != null ? ctx.amount_paid_cents : 0));
    if (paid > 0) return true;
    return Number(ctx.payments_paid_cents || 0) > 0;
  }

  function canDeleteBooking(row, ctx) {
    // Delete/archive only when already cancelled (ghost). Never Active → Deleted.
    if (!ctx || !ctx.booking_id) return false;
    if (!bookingIsCancelled(ctx, row)) return false;
    if (typeof scheduleDrawerCanLoadCanonical === 'function') {
      return scheduleDrawerCanLoadCanonical(row || scheduleDrawerState.row);
    }
    return false;
  }

  function canCancelBooking(row, ctx) {
    if (!ctx || !ctx.booking_id) return false;
    if (bookingIsCancelled(ctx, row)) return false;
    if (typeof scheduleDrawerCanLoadCanonical === 'function') {
      return scheduleDrawerCanLoadCanonical(row || scheduleDrawerState.row);
    }
    return false;
  }

  function canRestoreBooking(row, ctx) {
    if (!ctx || !ctx.booking_id) return false;
    if (!bookingIsCancelled(ctx, row)) return false;
    if (typeof scheduleDrawerCanLoadCanonical === 'function') {
      return scheduleDrawerCanLoadCanonical(row || scheduleDrawerState.row);
    }
    return false;
  }

  function cancelConfirmMessage(ctx) {
    var msg = hasCapturedMoney(ctx)
      ? portalT('schedule.drawer.cancelBookingConfirmPaid')
      : portalT('schedule.drawer.cancelBookingConfirm');
    if (ctx && ctx.booking_code) msg += ' (' + String(ctx.booking_code) + ')';
    return msg;
  }

  function archiveConfirmMessage(ctx) {
    var msg = portalT('schedule.drawer.hideBookingConfirm') || portalT('schedule.drawer.deleteBookingConfirm');
    if (ctx && ctx.booking_code) msg += ' (' + String(ctx.booking_code) + ')';
    return msg;
  }

  function restoreConfirmMessage(ctx) {
    var msg = portalT('schedule.drawer.restoreBookingConfirm');
    if (ctx && ctx.booking_code) msg += ' (' + String(ctx.booking_code) + ')';
    return msg;
  }

  function executeBookingCancel(identity, bookingId) {
    if (!bookingId) return;
    if (!actionIsActive(identity)) return;
    if (flight.cancelBooking) return;
    flight.cancelBooking = true;
    var btn = el('ps-drawer-cancel-booking');
    if (btn) btn.disabled = true;
    requestJson('/staff/schedule/bookings/cancel?' + clientQuery(), {
      method: 'POST',
      body: { booking_id: bookingId },
    }).then(function(res) {
      if (!actionIsActive(identity)) return;
      if (!res.ok || !res.data || res.data.success !== true) {
        var d = res.data || {};
        var msg = d.message || d.error || 'Cancel failed';
        if (d.detail) msg += ' (' + String(d.detail).slice(0, 180) + ')';
        throw new Error(msg);
      }
      flight.cancelBooking = false;
      closeScheduleDetailDrawer();
      loadSchedulePage();
    }).catch(function(err) {
      if (!actionIsActive(identity)) return;
      var m = el('ps-drawer-save-msg');
      if (m) {
        m.className = 'state-msg error';
        m.textContent = portalT('schedule.drawer.cancelBookingFailed') + ' ' + errorText(err);
        m.style.display = 'block';
      }
      if (btn) btn.disabled = false;
      flight.cancelBooking = false;
    });
  }

  function executeBookingArchive(identity, bookingId) {
    if (!bookingId) return;
    if (!actionIsActive(identity)) return;
    if (flight.deleteBooking) return;
    flight.deleteBooking = true;
    var btn = el('ps-drawer-delete-booking');
    if (btn) btn.disabled = true;
    requestJson('/staff/schedule/bookings?' + clientQuery(), {
      method: 'DELETE',
      body: { booking_id: bookingId },
    }).then(function(res) {
      if (!actionIsActive(identity)) return;
      if (!res.ok || !res.data || res.data.success !== true) {
        throw new Error((res.data && (res.data.error || res.data.message)) || 'Remove failed');
      }
      flight.deleteBooking = false;
      closeScheduleDetailDrawer();
      loadSchedulePage();
    }).catch(function(err) {
      if (!actionIsActive(identity)) return;
      var m = el('ps-drawer-save-msg');
      if (m) {
        m.className = 'state-msg error';
        m.textContent = portalT('schedule.drawer.deleteBookingFailed') + ' ' + errorText(err);
        m.style.display = 'block';
      }
      if (btn) btn.disabled = false;
      flight.deleteBooking = false;
    });
  }

  function cancelBookingFromDrawer() {
    var st = scheduleDrawerState;
    if (!st || !st.ctx || !st.row) return;
    if (!canCancelBooking(st.row, st.ctx)) return;
    var bookingId = st.ctx.booking_id;
    if (!bookingId) return;
    var identity = captureIdentity(st.row);
    if (!actionIsActive(identity)) return;
    if (flight.cancelBooking) return;
    var confirmFn = (typeof window !== 'undefined' && window.confirm) ? window.confirm : null;
    if (confirmFn && !confirmFn(cancelConfirmMessage(st.ctx))) return;
    if (!actionIsActive(identity)) return;
    executeBookingCancel(identity, bookingId);
  }

  function executeBookingRestore(identity, bookingId) {
    if (!bookingId) return;
    if (!actionIsActive(identity)) return;
    if (flight.restoreBooking) return;
    flight.restoreBooking = true;
    var btn = el('ps-drawer-restore-booking');
    if (btn) btn.disabled = true;
    requestJson('/staff/schedule/bookings/restore?' + clientQuery(), {
      method: 'POST',
      body: { booking_id: bookingId },
    }).then(function(res) {
      if (!actionIsActive(identity)) return;
      if (!res.ok || !res.data || res.data.success !== true) {
        var d = res.data || {};
        var msg = d.message || d.error || 'Restore failed';
        if (d.detail) msg += ' (' + String(d.detail).slice(0, 180) + ')';
        throw new Error(msg);
      }
      flight.restoreBooking = false;
      closeScheduleDetailDrawer();
      loadSchedulePage();
    }).catch(function(err) {
      if (!actionIsActive(identity)) return;
      var m = el('ps-drawer-save-msg');
      if (m) {
        m.className = 'state-msg error';
        m.textContent = portalT('schedule.drawer.restoreBookingFailed') + ' ' + errorText(err);
        m.style.display = 'block';
      }
      if (btn) btn.disabled = false;
      flight.restoreBooking = false;
    });
  }

  function restoreBookingFromDrawer() {
    var st = scheduleDrawerState;
    if (!st || !st.ctx || !st.row) return;
    if (!canRestoreBooking(st.row, st.ctx)) return;
    var bookingId = st.ctx.booking_id;
    if (!bookingId) return;
    var identity = captureIdentity(st.row);
    if (!actionIsActive(identity)) return;
    if (flight.restoreBooking) return;
    var confirmFn = (typeof window !== 'undefined' && window.confirm) ? window.confirm : null;
    if (confirmFn && !confirmFn(restoreConfirmMessage(st.ctx))) return;
    if (!actionIsActive(identity)) return;
    executeBookingRestore(identity, bookingId);
  }

  function deleteBookingFromDrawer() {
    var st = scheduleDrawerState;
    if (!st || !st.ctx || !st.row) return;
    // Never permit direct Active → Deleted.
    if (!canDeleteBooking(st.row, st.ctx)) return;
    var bookingId = st.ctx.booking_id;
    if (!bookingId) return;
    var identity = captureIdentity(st.row);
    if (!actionIsActive(identity)) return;
    if (flight.deleteBooking) return;
    var confirmFn = (typeof window !== 'undefined' && window.confirm) ? window.confirm : null;
    if (confirmFn && !confirmFn(archiveConfirmMessage(st.ctx))) return;
    if (!actionIsActive(identity)) return;
    executeBookingArchive(identity, bookingId);
  }

  function wireDeleteBooking() {
    var st = scheduleDrawerState;
    var delBtn = el('ps-drawer-delete-booking');
    var cancelBtn = el('ps-drawer-cancel-booking');
    var restoreBtn = el('ps-drawer-restore-booking');
    if (cancelBtn) {
      if (!canCancelBooking(st && st.row, st && st.ctx)) {
        cancelBtn.style.display = 'none';
      } else {
        cancelBtn.style.display = '';
        cancelBtn.disabled = flight.cancelBooking;
        cancelBtn.onclick = cancelBookingFromDrawer;
      }
    }
    if (restoreBtn) {
      if (!canRestoreBooking(st && st.row, st && st.ctx)) {
        restoreBtn.style.display = 'none';
      } else {
        restoreBtn.style.display = '';
        restoreBtn.disabled = flight.restoreBooking;
        restoreBtn.onclick = restoreBookingFromDrawer;
      }
    }
    if (delBtn) {
      if (!canDeleteBooking(st && st.row, st && st.ctx)) {
        delBtn.style.display = 'none';
      } else {
        delBtn.style.display = '';
        delBtn.disabled = flight.deleteBooking;
        delBtn.onclick = deleteBookingFromDrawer;
      }
    }
  }

  var api = {
    requestJson: requestJson,
    flight: flight,
    paymentFullyPaid: paymentFullyPaid,
    paymentStatusLabel: paymentStatusLabel,
    paymentShortUrl: paymentShortUrl,
    paymentActionableDisplayUrl: paymentActionableDisplayUrl,
    stripeStatusLabel: stripeStatusLabel,
    renderPaymentSectionHtml: renderPaymentSectionHtml,
    renderManualPaymentHtml: renderManualPaymentHtml,
    renderStripeLinkSectionHtml: renderStripeLinkSectionHtml,
    paymentRefetchAndRemount: paymentRefetchAndRemount,
    updatePaymentFromContext: updatePaymentFromContext,
    wireStripeCopyOpen: wireStripeCopyOpen,
    deleteStripeLink: deleteStripeLink,
    createStripeLink: createStripeLink,
    wireManualPayment: wireManualPayment,
    wireMarkAsPaid: wireMarkAsPaid,
    wirePaymentLedgerEdits: wirePaymentLedgerEdits,
    waiverStatusLabel: waiverStatusLabel,
    waiverIsGroup: waiverIsGroup,
    waiverTargetCount: waiverTargetCount,
    waiverCompletedCount: waiverCompletedCount,
    renderWaiverBoxInner: renderWaiverBoxInner,
    wireWaiver: wireWaiver,
    viewWaiverAnswers: viewWaiverAnswers,
    renderWaiverSubmissionBlock: renderWaiverSubmissionBlock,
    renderWaiverAnswers: renderWaiverAnswers,
    loadWaiver: loadWaiver,
    createWaiver: createWaiver,
    canDeleteBooking: canDeleteBooking,
    canCancelBooking: canCancelBooking,
    canRestoreBooking: canRestoreBooking,
    cancelBookingFromDrawer: cancelBookingFromDrawer,
    restoreBookingFromDrawer: restoreBookingFromDrawer,
    deleteBookingFromDrawer: deleteBookingFromDrawer,
    bookingIsCancelled: bookingIsCancelled,
    hasCapturedMoney: hasCapturedMoney,
    wireDeleteBooking: wireDeleteBooking,
    actionIsActive: actionIsActive,
  };
  Object.freeze(api);
  return api;
})();

function scheduleDrawerPaymentFullyPaid(ctx) { return SunsetScheduleDrawerActions.paymentFullyPaid(ctx); }
function schedulePaymentStatusLabel(status, method) { return SunsetScheduleDrawerActions.paymentStatusLabel(status, method); }
function scheduleDrawerPaymentShortUrl(ctx) { return SunsetScheduleDrawerActions.paymentShortUrl(ctx); }
function scheduleDrawerPaymentActionableDisplayUrl(ctx) { return SunsetScheduleDrawerActions.paymentActionableDisplayUrl(ctx); }
function scheduleStripeStatusLabel(raw) { return SunsetScheduleDrawerActions.stripeStatusLabel(raw); }
function scheduleRenderDrawerPaymentSectionHtml(ctx, editable) { return SunsetScheduleDrawerActions.renderPaymentSectionHtml(ctx, editable); }
function scheduleRenderDrawerManualPaymentHtml(ctx) { return SunsetScheduleDrawerActions.renderManualPaymentHtml(ctx); }
function scheduleRenderDrawerStripeLinkSectionHtml(ctx) { return SunsetScheduleDrawerActions.renderStripeLinkSectionHtml(ctx); }
function scheduleDrawerPaymentRefetchAndRemount(row) { return SunsetScheduleDrawerActions.paymentRefetchAndRemount(row, null); }
function scheduleUpdateDrawerPaymentFromContext(ctx) { return SunsetScheduleDrawerActions.updatePaymentFromContext(ctx); }
function scheduleWireDrawerStripeCopyOpen(ctx) { return SunsetScheduleDrawerActions.wireStripeCopyOpen(ctx); }
function scheduleDeleteDrawerStripeLink(ctx) { return SunsetScheduleDrawerActions.deleteStripeLink(ctx); }
function scheduleCreateDrawerStripeLink(row) { return SunsetScheduleDrawerActions.createStripeLink(row); }
function scheduleWireDrawerManualPayment(row) { return SunsetScheduleDrawerActions.wireManualPayment(row); }

function scheduleWaiverStatusLabel(status) { return SunsetScheduleDrawerActions.waiverStatusLabel(status); }
function scheduleWaiverIsGroup(data) { return SunsetScheduleDrawerActions.waiverIsGroup(data); }
function scheduleWaiverTargetCount(data) { return SunsetScheduleDrawerActions.waiverTargetCount(data); }
function scheduleWaiverCompletedCount(data) { return SunsetScheduleDrawerActions.waiverCompletedCount(data); }
function scheduleRenderWaiverBoxInner(data) { return SunsetScheduleDrawerActions.renderWaiverBoxInner(data); }
function scheduleWireDrawerWaiver(data) { return SunsetScheduleDrawerActions.wireWaiver(data); }
function scheduleViewDrawerWaiverAnswers(data) { return SunsetScheduleDrawerActions.viewWaiverAnswers(data); }
function scheduleRenderWaiverSubmissionBlock(sub) { return SunsetScheduleDrawerActions.renderWaiverSubmissionBlock(sub); }
function scheduleRenderWaiverAnswers(payload) { return SunsetScheduleDrawerActions.renderWaiverAnswers(payload); }
function scheduleLoadDrawerWaiver(ctx) { return SunsetScheduleDrawerActions.loadWaiver(ctx); }
function scheduleCreateDrawerWaiver() { return SunsetScheduleDrawerActions.createWaiver(); }

function scheduleDrawerCanDeleteBooking(row, ctx) { return SunsetScheduleDrawerActions.canDeleteBooking(row, ctx); }
function scheduleDrawerDeleteActionIsActive(openGen, bookingKey) {
  return SunsetScheduleDrawerActions.actionIsActive({ openGen: openGen, bookingKey: bookingKey });
}
function scheduleDeleteBookingFromDrawer() { return SunsetScheduleDrawerActions.deleteBookingFromDrawer(); }
function scheduleCancelBookingFromDrawer() { return SunsetScheduleDrawerActions.cancelBookingFromDrawer(); }
function scheduleRestoreBookingFromDrawer() { return SunsetScheduleDrawerActions.restoreBookingFromDrawer(); }
function scheduleDrawerCanCancelBooking(row, ctx) { return SunsetScheduleDrawerActions.canCancelBooking(row, ctx); }
function scheduleDrawerCanRestoreBooking(row, ctx) { return SunsetScheduleDrawerActions.canRestoreBooking(row, ctx); }
function scheduleDrawerBookingIsCancelled(ctx, row) { return SunsetScheduleDrawerActions.bookingIsCancelled(ctx, row); }
function scheduleWireDrawerDeleteBooking() { return SunsetScheduleDrawerActions.wireDeleteBooking(); }
