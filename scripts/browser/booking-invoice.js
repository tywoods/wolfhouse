/* Wolfhouse Invoice workspace. Injected into the existing portal closure. */
function bcInvoiceFinancials(bk){
  var data = bcLastBookingContext, drawer = el('bc-side-drawer');
  if (getClient() !== 'wolfhouse-somo' || !data || data.booking !== bk || !bk.booking_id || !bk.booking_code
    || (bk.client_slug && bk.client_slug !== 'wolfhouse-somo')
    || (data.client_slug && data.client_slug !== 'wolfhouse-somo')
    || !drawer || !document.contains(drawer)) return null;
  // loadBlockDetail admits the current context before rendering; the guest
  // binder stamps mounted identity only afterwards. Read that admitted context
  // against the active booking, not the previous booking's late-bound stamp.
  // Dispatch still requires the mounted identity and view generation below.
  var block = typeof bcLastOpenedBlock !== 'undefined' ? bcLastOpenedBlock : null;
  if (block && (block.booking_code !== bk.booking_code || (block.booking_id && block.booking_id !== bk.booking_id))) return null;
  var detail = el('bc-detail'), body = el('bc-ctx-body');
  var primaryOwnsBody = detail && body && document.contains(detail) && document.contains(body)
    && detail.contains(body) && detail.style.display === 'block';
  if (drawer.getAttribute('data-mounted-booking-id') !== bk.booking_id
    && !(block && (primaryOwnsBody || (drawer.classList && drawer.classList.contains('is-open') && drawer.dataset && drawer.dataset.mode === 'booking')))) return null;
  var f = data.financials;
  if (typeof bcInvoiceRefreshState !== 'undefined' && bcInvoiceRefreshState && bcInvoiceRefreshState.context === data) return null;
  if (!f || f.schema_version !== 1 || typeof f.currency !== 'string' || !/^[A-Z]{3}$/.test(f.currency)
    || !f.value_sources || typeof f.value_sources !== 'object') return null;
  return f;
}
function bcInvoiceFinancialValue(bk, key){
  var f = bcInvoiceFinancials(bk);
  if (!f || typeof f.value_sources[key] !== 'string' || !f.value_sources[key]
    || f.value_sources[key].indexOf('unknown') === 0) return null;
  var value = f[key];
  if (key === 'needs_refund' || key === 'collection_needs_refund') return typeof value === 'boolean' ? value : null;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function bcInvoiceBookingFullyPaid(data){
  data = data || {};
  var fin = bcComputeBookingInvoiceTotals(data.booking || {}, data.service_records || [], data.payments || {}, data.transfers || [], data.guest_accommodation_lines || []);
  return Number.isSafeInteger(fin.invoiceTotal) && fin.invoiceTotal > 0 && Number.isSafeInteger(fin.paidCents) && fin.paidCents >= fin.invoiceTotal;
}
function bcBookingPaymentChoice(bk){
  bk = bk || {};
  var meta = bk.metadata;
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch (_e) { meta = null; }
  }
  if (!meta || typeof meta !== 'object') meta = {};
  var snap = meta.quote_snapshot && typeof meta.quote_snapshot === 'object' ? meta.quote_snapshot : {};
  return String(
    bk.payment_choice || bk.paid_amount_type ||
    meta.payment_choice || meta.paid_amount_type ||
    snap.payment_choice || ''
  ).toLowerCase();
}
function bcInvoiceDepositRowHtml(bk, paidCents, invoiceTotal){
  invoiceTotal = bcInvoiceFinancialValue(bk, 'invoice_total_cents');
  paidCents = bcInvoiceFinancialValue(bk, 'paid_total_cents');
  var choice = bcBookingPaymentChoice(bk);
  var isFull = choice === 'full' || choice === 'full_amount' || choice === 'pay_now' || choice === 'stripe_full' || choice === 'together';
  if (isFull) {
    var fullAmount = bcInvoiceMoney(bk, invoiceTotal);
    var fullPaid = Number.isSafeInteger(paidCents) && Number.isSafeInteger(invoiceTotal) && invoiceTotal > 0 && paidCents >= invoiceTotal;
    var fullState = fullPaid ? 'paid' : (Number.isSafeInteger(paidCents) ? 'unpaid' : 'unknown');
    return '<div class="ctx-inv-total-row"><span class="ctx-inv-total-label">' + escHtml(t('calendar.create.pay.full')) + '</span><span class="ctx-inv-total-amount bc-invoice-deposit-amount" data-deposit-state="' + fullState + '" data-payment-choice="' + escHtml(choice || 'full') + '">' + escHtml(fullAmount) + '</span></div>';
  }
  var required = bcInvoiceFinancialValue(bk, 'deposit_display_cents');
  var outstanding = bcInvoiceFinancialValue(bk, 'deposit_outstanding_cents');
  var state = required != null && outstanding != null ? (outstanding === 0 ? 'paid' : 'unpaid') : 'unknown';
  var amount = bcInvoiceMoney(bk, required);
  var canCreate = bcInvoiceCollectionReady(bk, 'deposit');
  return '<div class="ctx-inv-total-row"><span class="ctx-inv-total-label">' + escHtml(t('calendar.create.pay.deposit')) + '</span><span class="ctx-inv-total-amount bc-invoice-deposit-amount" data-deposit-state="' + state + '" data-payment-choice="' + escHtml(choice || '') + '" title="' + escHtml(state === 'paid' ? bcInvoiceText('paidInFull') : (state === 'unpaid' ? bcInvoiceText('outstanding') : bcInvoiceText('notAvailable'))) + '">' + escHtml(amount) + '</span>' + (canCreate ? bcInvoiceTotalLinkActionHtml('deposit') : '') + '</div>';
}
function bcInvoiceTotalLinkActionHtml(target){
  var deposit = target === 'deposit', label = bcInvoiceText(deposit ? 'guestDeposit' : 'guestFull');
  return '<span class="bc-total-link-action"><button type="button" class="btn btn-ghost bc-total-create-link" id="' + (deposit ? 'bc-generate-deposit-link-btn' : 'bc-generate-payment-link-btn') + '" data-payment-target="' + target + '">' + escHtml(label) + '</button><span id="' + (deposit ? 'bc-deposit-link-result' : 'bc-payment-link-result') + '" aria-live="polite"></span></span>';
}
function bcInitInvoiceTotalLinks(data){
  var bk = data.booking || {}, client = getClient();
  bcInitDetailCopyDelegation();
  document.querySelectorAll('#bc-inv-totals .bc-total-create-link').forEach(function(btn){
    if (btn._bcTotalBound) return;
    btn._bcTotalBound = true;
    var target = btn.getAttribute('data-payment-target');
    var result = el(target === 'deposit' ? 'bc-deposit-link-result' : 'bc-payment-link-result');
    if (!BC_STAFF_ACTIONS || !BC_STRIPE_LINKS || !bcInvoiceCollectionReady(bk, target)) { btn.disabled = true; btn.title = t('drawer.payments.stripeDisabled'); return; }
    var intent = null;
    btn.addEventListener('click', async function(){
      if (btn.disabled) return;
      var drawer = el('bc-side-drawer'), generation = drawer && drawer.getAttribute('data-booking-view-generation');
      function current(){ return getClient() === client && document.contains(btn) && document.contains(result) && drawer && drawer.getAttribute('data-booking-view-generation') === generation && drawer.getAttribute('data-mounted-booking-id') === bk.booking_id; }
      if (!current() || !bcInvoiceCollectionReady(bk, target)) return;
      btn.disabled = true; result.textContent = '';
      // Keep the same intent on an ambiguous retry. A read/reset remounts the controls.
      if (!intent) intent = bcNewPaymentLinkIdempotencyKey();
      try {
        var response = await fetch('/staff/bookings/generate-payment-link?client=' + encodeURIComponent(client), {
          method:'POST', headers:{'Content-Type':'application/json',Accept:'application/json'},
          body:JSON.stringify({client_slug:client,booking_id:bk.booking_id,booking_code:bk.booking_code,payment_target:target,idempotency_key:intent})
        });
        var payload = await response.json();
        if (!current()) return;
        if (!response.ok || !payload.success) throw new Error(payload.message || payload.error || t('drawer.payments.linkFailed'));
        var link = payload.payment_short_url || payload.checkout_url || payload.guest_payment_url || payload.payment_link_url;
        var parsed = new URL(link);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error(t('drawer.payments.linkFailed'));
        result.innerHTML = bcInlinePaymentLinkMarkup(link, bcInvoiceText(target === 'deposit' ? 'guestDeposit' : 'guestFull'));
        btn.remove();
      } catch (error) {
        if (current()) { result.textContent = error.message || t('drawer.payments.linkFailed'); btn.disabled = false; }
      }
    });
  });
}

var bcInvoiceReceiptIntents = Object.create(null);
var bcInvoiceRefreshNumber = 0;
var bcInvoiceRefreshState = null;
// Context objects, not booking IDs or view generations, delimit recovery chains.
// Weak membership survives remounts without retaining closed booking payloads.
var bcInvoiceRecoveryAttempted = new WeakSet();
function bcInvoiceParseCents(value){
  var text = String(value || '').trim();
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(text)) return null;
  var parts = text.replace(',', '.').split('.');
  var cents = Number(parts[0]) * 100 + Number(((parts[1] || '') + '00').slice(0,2));
  return Number.isSafeInteger(cents) && cents > 0 && cents <= 2147483647 ? cents : null;
}
function bcInvoiceFeedback(message){ var box = el('bc-invoice-feedback'); if (box) box.textContent = message; }
async function bcRefreshInvoice(data){
  var client = getClient(), bk = data.booking || {}, drawer = el('bc-side-drawer');
  var cached = bcLastBookingContext;
  function ownsContext(){
    var block = typeof bcLastOpenedBlock !== 'undefined' ? bcLastOpenedBlock : null;
    return bcLastBookingContext === cached && cached && cached.booking
      && cached.booking.booking_id === bk.booking_id && cached.booking.booking_code === bk.booking_code
      && (!block || (block.booking_code === bk.booking_code && (!block.booking_id || block.booking_id === bk.booking_id)));
  }
  // Reject an old caller before it can invalidate the new booking's generation.
  if (!ownsContext() || !drawer || !document.contains(drawer)
    || drawer.getAttribute('data-mounted-booking-id') !== bk.booking_id) return null;
  data = cached; bk = cached.booking;
  bcInvoiceRecoveryAttempted.add(cached);
  var generation = String(Number(drawer && drawer.getAttribute('data-booking-view-generation') || 0) + 1);
  if (drawer) drawer.setAttribute('data-booking-view-generation', generation);
  var request = ++bcInvoiceRefreshNumber;
  // One context-scoped freshness owner; retain payload facts and guest lists.
  bcInvoiceRefreshState = {context:cached, request:request};
  var scrollOwner = el('bc-side-body') || drawer;
  var scroll = scrollOwner && scrollOwner.scrollTop;
  function stillCurrent(){ return ownsContext() && request === bcInvoiceRefreshNumber && getClient() === client && drawer && document.contains(drawer) && drawer.getAttribute('data-booking-view-generation') === generation && drawer.getAttribute('data-mounted-booking-id') === bk.booking_id; }
  var fresh;
  try {
    var response = await fetch('/staff/bookings/' + encodeURIComponent(bk.booking_code) + '/context?client=' + encodeURIComponent(client));
    fresh = await response.json();
    if (!response.ok || !fresh.success || !fresh.booking || fresh.booking.booking_id !== bk.booking_id
      || fresh.booking.booking_code !== bk.booking_code || (fresh.client_slug && fresh.client_slug !== client)
      || (fresh.booking.client_slug && fresh.booking.client_slug !== client)) throw new Error('invoice_refresh_failed');
  } catch (error) {
    if (!stillCurrent()) return null;
    // Remount the complete cached context with unavailable financials and an
    // explicit retry, without accepting late URLs or replaying successful POSTs.
    bcUpdateOverviewPaymentSummary(data);
    if (scrollOwner) scrollOwner.scrollTop = scroll;
    bcInvoiceFeedback(bcInvoiceText('refreshFailed'));
    throw error;
  }
  if (!stillCurrent()) return null;
  bcInvoiceRefreshState = null;
  // A refresh's own replacement must not start another automatic recovery.
  bcInvoiceRecoveryAttempted.add(fresh);
  bcLastBookingContext = fresh;
  bcUpdateOverviewPaymentSummary(fresh);
  updateBcDetailHeader(fresh);
  if (scrollOwner) scrollOwner.scrollTop = scroll;
  return fresh;
}
function bcInvoiceText(key){ return t('drawer.invoice.' + key); }
function bcWolfhouseStayDepositCents(bk){
  return bcInvoiceFinancialValue(bk, 'deposit_required_cents');
}
function bcInvoiceCollectionReady(bk, target){
  return !bcBookingStatusIsCancelled(bk.status)
    && bcInvoiceFinancialValue(bk, 'collection_needs_refund') === false
    && bcInvoiceFinancialValue(bk, target === 'deposit' ? 'deposit_outstanding_cents' : 'collection_balance_due_cents') > 0;
}
function bcInvoiceMoney(bk, cents){
  var f = bcInvoiceFinancials(bk);
  if (!f || !Number.isSafeInteger(cents) || cents < 0) return '—';
  return typeof formatStaffPortalMoney === 'function' ? (formatStaffPortalMoney(cents, f.currency) || '—')
    : (f.currency === 'EUR' ? '€' : f.currency + ' ') + (cents / 100).toFixed(2);
}
function bcInvoiceActionsHtml(bk){
  return '<div class="bc-invoice-actions" id="bc-invoice-actions">' +
    '<button type="button" class="btn btn-primary" id="bc-record-payment-btn"' + (bcBookingStatusIsCancelled(bk.status) ? ' disabled' : '') + '>' + escHtml(bcInvoiceText('recordPayment')) + '</button>' +
    '<button type="button" class="btn btn-ghost" id="bc-refresh-links-btn" title="' + escHtml(bcInvoiceText('refreshHint')) + '">' + escHtml(bcInvoiceText('refreshLinks')) + '</button>' +
    '</div><div id="bc-invoice-feedback" role="status" aria-live="polite"></div>';
}
function bcInvoiceStyles(){
  if (el('bc-invoice-styles')) return;
  var style = document.createElement('style'); style.id = 'bc-invoice-styles';
  style.textContent = '.bc-invoice-actions{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}.bc-invoice-actions .btn{min-height:40px}.bc-invoice-history{margin-top:14px}#bc-payment-history-body[hidden]{display:none}:is(#bc-record-payment-dialog,#ps-record-payment-dialog){position:fixed;inset:auto 12px 12px auto;margin:0;box-sizing:border-box;width:min(460px,calc(100vw - 24px));max-height:90dvh;overflow:auto;border:1px solid var(--border-soft);border-radius:16px;padding:24px;background:var(--surface);color:var(--text);box-shadow:0 16px 64px #0005}:is(#bc-record-payment-dialog,#ps-record-payment-dialog)::backdrop{background:#0006}:is(#bc-record-payment-dialog,#ps-record-payment-dialog) label,:is(#bc-record-payment-dialog,#ps-record-payment-dialog) legend{display:block;font-size:13px;margin:12px 0 6px}:is(#bc-record-payment-dialog,#ps-record-payment-dialog) input:not([type=radio]),:is(#bc-record-payment-dialog,#ps-record-payment-dialog) select{box-sizing:border-box;width:100%;min-height:42px;background:var(--surface);color:var(--text);border:1px solid var(--border-soft);border-radius:8px;padding:8px}:is(#bc-record-payment-dialog,#ps-record-payment-dialog) fieldset{border:0;padding:0;margin:0}.bc-payment-methods{display:flex;gap:8px}.bc-payment-methods label{display:flex!important;align-items:center;gap:8px;flex:1;padding:12px;border:1px solid var(--border-soft);border-radius:8px}.bc-payment-buttons{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}#bc-payment-error{color:var(--danger,#b33434);font-size:13px;margin-top:8px}#bc-payment-summary,#bc-payment-outstanding{font-size:12px;margin-top:10px}:is(#bc-record-payment-dialog,#ps-record-payment-dialog) h3{margin-top:0}:is(#bc-record-payment-dialog,#ps-record-payment-dialog) .btn{min-height:42px}@media(max-width:600px){:is(#bc-record-payment-dialog,#ps-record-payment-dialog){inset:auto 0 0 0;width:100%;max-width:100%;max-height:90dvh;margin:0;border-radius:16px 16px 0 0;padding:20px}}';
  // Shared WH/Sunset read rows: name | package | bed | payment.
  // Subgrid keeps columns aligned even when a guest has no bed/package.
  // Chips size to their text. The names row is the scrollport, not the card.
  // A narrow drawer scrolls; it must not wrap, squeeze, or clip chips.
  var guestScope = '#bc-drawer-card-booking #bc-field-group-guests:not(.is-editing) ';
  style.textContent += guestScope + '.ctx-field-read-row{min-width:0;max-width:100%}';
  style.textContent += guestScope + '.ctx-field-kv-grid{flex:1 1 0;width:auto;min-width:0;max-width:100%}';
  style.textContent += guestScope + '#bc-field-guests-kv-only,' + guestScope + '#bc-field-guests-kv-only .v{display:block;width:100%;min-width:0;max-width:100%}';
  style.textContent += guestScope + '#bc-guest-names{display:grid;grid-template-columns:minmax(40px,1fr) max-content max-content max-content;column-gap:6px;width:100%;min-width:0;max-width:100%;overflow-x:auto;overscroll-behavior-x:contain;scrollbar-width:thin}';
  style.textContent += guestScope + '#bc-guest-names::-webkit-scrollbar{height:8px}';
  style.textContent += guestScope + '#bc-guest-names::-webkit-scrollbar-thumb{background:var(--border);border-radius:8px}';
  guestScope += '#bc-guest-names ';
  style.textContent +=
    guestScope + '.bc-guest-name-row{display:grid;grid-column:1/-1;grid-template-columns:subgrid;align-items:center;gap:6px;white-space:normal}' +
    guestScope + '.bc-guest-name-line{grid-column:1;grid-row:1;display:block;min-width:0;white-space:normal;overflow:visible;overflow-wrap:anywhere;text-overflow:clip}' +
    guestScope + '.bc-guest-pebble-line{display:contents}' +
    guestScope + '.bc-guest-package-pebble{grid-column:2}' +
    guestScope + '.bc-guest-bed{grid-column:3}' +
    guestScope + '.bc-accom-pay-pebble{grid-column:4}' +
    guestScope + '.bc-guest-bed,' + guestScope + '.bc-guest-package-pebble,' + guestScope + '.bc-accom-pay-pebble{grid-row:1;justify-self:start;align-self:center;width:max-content;min-width:max-content;max-width:none;box-sizing:border-box;margin:0;padding:2px 6px;white-space:nowrap;overflow:visible;overflow-wrap:normal;word-break:normal;text-overflow:clip;text-align:center}' +
    guestScope + '.bc-guest-sep{display:none}' +
    guestScope + '.bc-guest-package-slot{min-width:4.75em;width:auto;padding:0;background:transparent;border:0;box-shadow:none;color:transparent;visibility:hidden}';
  document.head.appendChild(style);
}
function bcOpenRecordPayment(data){
  if (el('bc-record-payment-dialog')) return;
  var bk = data.booking || {}, client = getClient();
  var trigger = el('bc-record-payment-btn');
  var dialog = document.createElement('dialog'); dialog.id = 'bc-record-payment-dialog';
  dialog.setAttribute('aria-labelledby', 'bc-record-payment-title');
  var options = '<option value="booking">' + escHtml(bcInvoiceText('all')) + '</option>';
  (data.booking_guests || []).forEach(function(g){
    if (!g.booking_guest_id) return;
    options += '<option value="' + escHtml(g.booking_guest_id) + '">' + escHtml(bcInvoiceGuestStaffLabel(g.guest_number, g.guest_name, bk.guest_name) + ' (#' + g.guest_number + ')') + '</option>';
  });
  dialog.innerHTML = '<h3 id="bc-record-payment-title">' + escHtml(bcInvoiceText('recordPayment')) + '</h3><p class="muted">' + escHtml(bcInvoiceText('recordHint')) + '</p>' +
    '<form id="bc-record-payment-form" novalidate><label for="bc-payment-scope">' + escHtml(bcInvoiceText('guest')) + '</label><select id="bc-payment-scope" required>' + options + '</select>' +
    '<label for="bc-payment-amount">' + escHtml(bcInvoiceText('amount')) + '</label><input id="bc-payment-amount" inputmode="decimal" autocomplete="off" placeholder="0.00" required>' +
    '<div id="bc-payment-outstanding"></div><button type="button" class="btn btn-ghost" id="bc-payment-use-outstanding" hidden>' + escHtml(bcInvoiceText('useOutstanding')) + '</button>' +
    '<fieldset><legend>' + escHtml(bcInvoiceText('method')) + '</legend><div class="bc-payment-methods"><label><input type="radio" name="bc-payment-method" value="bank_transfer">' + escHtml(bcInvoiceText('bankTransfer')) + '</label><label><input type="radio" name="bc-payment-method" value="cash">' + escHtml(bcInvoiceText('cash')) + '</label></div></fieldset>' +
    '<details><summary>' + escHtml(bcInvoiceText('details')) + '</summary><label for="bc-payment-date">' + escHtml(t('drawer.payments.paymentDate')) + '</label><input type="date" id="bc-payment-date" value="' + new Date().toISOString().slice(0,10) + '"><label for="bc-payment-note">' + escHtml(t('drawer.payments.noteRef')) + '</label><input id="bc-payment-note" maxlength="500"></details>' +
    '<div id="bc-payment-summary" aria-live="polite"></div><div id="bc-payment-error" role="alert"></div><div class="bc-payment-buttons"><button type="button" class="btn btn-ghost" id="bc-payment-cancel">' + escHtml(t('drawer.field.cancel')) + '</button><button type="submit" class="btn btn-primary" id="bc-payment-submit">' + escHtml(bcInvoiceText('recordPayment')) + '</button></div></form>';
  document.body.appendChild(dialog);
  var busy = false;
  var identity = client + ':' + bk.booking_id;
  var form = el('bc-record-payment-form');
  var scope = el('bc-payment-scope'), amount = el('bc-payment-amount'), date = el('bc-payment-date'), note = el('bc-payment-note');
  var error = el('bc-payment-error'), submit = el('bc-payment-submit');
  function current(){ return getClient() === client && bcLastBookingContext && bcLastBookingContext.booking && bcLastBookingContext.booking.booking_id === bk.booking_id && document.contains(trigger); }
  function close(){ if (busy) return; dialog.close(); dialog.remove(); if (trigger && document.contains(trigger)) trigger.focus({preventScroll:true}); }
  function freeze(value){ form.querySelectorAll('input,select,button').forEach(function(e){ e.disabled = value; }); }
  function method(){ var selected = form.querySelector('input[name="bc-payment-method"]:checked'); return selected ? selected.value : ''; }
  function outstanding(){
    if (scope.value === 'booking') {
      return bcInvoiceFinancialValue(bk, 'collection_balance_due_cents');
    }
    var guest = (data.booking_guests || []).filter(function(g){ return g.booking_guest_id === scope.value; })[0];
    var share = guest && (guest.subtotal_cents != null ? Number(guest.subtotal_cents) : pgPayGuestSubtotalFromMetadata(guest.metadata || guest.guest_metadata));
    return !guest || share == null || guest.amount_paid_cents == null ? null : Math.max(0, share - Number(guest.amount_paid_cents));
  }
  function update(){
    var due = outstanding(), cents = bcInvoiceParseCents(amount.value);
    var use = el('bc-payment-use-outstanding'); use.hidden = !(due > 0);
    el('bc-payment-outstanding').textContent = due == null ? '' : bcInvoiceText('outstanding') + ': €' + (due / 100).toFixed(2);
    el('bc-payment-summary').textContent = scope.value && cents && method() ? bcInvoiceText('recordPayment') + ': €' + (cents / 100).toFixed(2) + ' — ' + scope.options[scope.selectedIndex].text + ' — ' + bcInvoiceText(method() === 'cash' ? 'cash' : 'bankTransfer') : '';
  }
  form.addEventListener('input', update); form.addEventListener('change', update);
  el('bc-payment-use-outstanding').addEventListener('click', function(){ var due = outstanding(); if (due > 0) amount.value = (due / 100).toFixed(2); update(); });
  dialog.addEventListener('keydown', function(ev){
    if (ev.key === 'Escape') ev.stopPropagation();
    if (ev.key !== 'Tab') return;
    var controls = Array.prototype.filter.call(dialog.querySelectorAll('button,input,select,textarea,summary,a[href],[tabindex="0"]'), function(e){ return !e.disabled && e.getClientRects().length; });
    var first = controls[0], last = controls[controls.length - 1];
    if (!first) { ev.preventDefault(); return; }
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  });
  dialog.addEventListener('cancel', function(ev){ ev.preventDefault(); close(); });
  el('bc-payment-cancel').addEventListener('click', close);
  var pending = bcInvoiceReceiptIntents[identity];
  if (pending && pending.uncertain) {
    scope.value = pending.body.booking_guest_id || 'booking'; amount.value = (pending.body.amount_cents / 100).toFixed(2);
    date.value = pending.body.payment_date; note.value = pending.body.note || '';
    form.querySelector('input[value="' + pending.body.method + '"]').checked = true;
    freeze(true); submit.disabled = false; el('bc-payment-cancel').disabled = false;
    error.textContent = bcInvoiceText('uncertain');
  }
  update();
  form.addEventListener('submit', async function(ev){
    ev.preventDefault(); if (busy) return;
    if (!current()) { error.textContent = bcInvoiceText('changedBooking'); return; }
    var cents = bcInvoiceParseCents(amount.value);
    if (!scope.value || !cents || !method()) { error.textContent = bcInvoiceText('invalidPayment'); return; }
    var body = {client_slug:client, booking_code:bk.booking_code, booking_id:bk.booking_id,
      payment_scope:scope.value === 'booking' ? 'booking' : 'guest', booking_guest_id:scope.value === 'booking' ? null : scope.value,
      amount_cents:cents, method:method(), payment_date:date.value, note:note.value.trim() || null};
    var fingerprint = JSON.stringify(body), intent = bcInvoiceReceiptIntents[identity];
    if (intent && intent.uncertain && intent.fingerprint !== fingerprint) { error.textContent = bcInvoiceText('uncertain'); return; }
    if (!intent || intent.fingerprint !== fingerprint) intent = {fingerprint:fingerprint, key:bcNewCashPaymentIdempotencyKey(), body:body};
    bcInvoiceReceiptIntents[identity] = intent;
    busy = true; freeze(true); error.textContent = ''; intent.uncertain = true;
    var confirmed = false;
    try {
      var response = await fetch('/staff/bookings/record-cash-payment?client=' + encodeURIComponent(client), {
        method:'POST', headers:{'Content-Type':'application/json',Accept:'application/json'}, body:JSON.stringify(Object.assign({}, body, {idempotency_key:intent.key}))
      });
      var result = await response.json();
      if (!response.ok || !result.success) {
        if (response.status >= 400 && response.status < 500) { intent.uncertain = false; freeze(false); }
        else { submit.disabled = false; el('bc-payment-cancel').disabled = false; }
        error.textContent = intent.uncertain ? bcInvoiceText('uncertain') : (result.message || result.error || bcInvoiceText('invalidPayment'));
        return;
      }
      confirmed = true; delete bcInvoiceReceiptIntents[identity];
      busy = false; close();
      if (!current()) return;
      try { if (await bcRefreshInvoice(data)) bcInvoiceFeedback(bcInvoiceText('recorded')); }
      catch (_) { if (getClient() === client && el('bc-side-drawer').getAttribute('data-mounted-booking-id') === bk.booking_id) bcInvoiceFeedback(bcInvoiceText('recordedRefreshFailed')); }
    } catch (_) {
      if (!confirmed) { error.textContent = bcInvoiceText('uncertain'); submit.disabled = false; el('bc-payment-cancel').disabled = false; }
    } finally { busy = false; }
  });
  dialog.showModal(); scope.focus();
}
function bcInitInvoiceWorkspace(data){
  if (getClient() !== 'wolfhouse-somo') return;
  var bk = data && data.booking, drawer = el('bc-side-drawer');
  var block = typeof bcLastOpenedBlock !== 'undefined' ? bcLastOpenedBlock : null;
  if (data === bcLastBookingContext && bk && bk.booking_id && bk.booking_code
    && (!data.client_slug || data.client_slug === 'wolfhouse-somo')
    && (!bk.client_slug || bk.client_slug === 'wolfhouse-somo')
    && (!block || (block.booking_code === bk.booking_code && (!block.booking_id || block.booking_id === bk.booking_id)))
    && drawer && document.contains(drawer)
    && (!data.financials || data.financials.schema_version !== 1)
    && !bcInvoiceRecoveryAttempted.has(data)) {
    bcInvoiceRecoveryAttempted.add(data);
    var requestAtInit = bcInvoiceRefreshNumber;
    // First-open cash shell runs BEFORE the guest binder stamps mounted ID.
    // Defer only to the end of that synchronous mount; refresh retains sole
    // ownership of mounted admission, request order and financial freshness.
    Promise.resolve().then(function(){
      if (getClient() !== 'wolfhouse-somo' || bcLastBookingContext !== data
        || bcInvoiceRefreshNumber !== requestAtInit
        || (data.client_slug && data.client_slug !== 'wolfhouse-somo')
        || (bk.client_slug && bk.client_slug !== 'wolfhouse-somo')
        || el('bc-side-drawer') !== drawer || !document.contains(drawer)) return;
      return bcRefreshInvoice(data);
    }).catch(function(){ /* Existing refresher remounts unavailable + retry. */ });
  }
  bcInvoiceStyles();
  var refresh = el('bc-refresh-links-btn');
  if (refresh && !refresh._invoiceBound) {
    refresh._invoiceBound = true;
    refresh.addEventListener('click', async function(){
      refresh.disabled = true;
      bcInvoiceFeedback('');
      try { await bcRefreshInvoice(data); }
      catch (_) { if (document.contains(refresh)) bcInvoiceFeedback(bcInvoiceText('refreshFailed')); }
      finally { if (document.contains(refresh)) refresh.disabled = false; }
    });
  }
  var open = el('bc-record-payment-btn');
  if (open && !open._invoiceBound) {
    open._invoiceBound = true;
    if (!BC_STAFF_ACTIONS) open.disabled = true;
    open.addEventListener('click', function(){ bcOpenRecordPayment(data); });
  }
}
