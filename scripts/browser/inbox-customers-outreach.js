/**
 * Staff Portal Inbox, Customers tab: outreach drawer, saved message templates, and the
 * confirm-then-send flow for messaging explicitly selected customers.
 *
 * Injected into /staff/ui at the inbox-customers-outreach marker. Fragment spliced into
 * the portal IIFE; depends on siblings there (getClient, portalT, escHtml) and on
 * CUSTOMERS_OUTREACH_MESSAGE_MIN, which stays in the template because the server
 * interpolates it.
 */

function customersOutreachSendUrl() {
  return '/staff/customers/outreach/send?client=' + encodeURIComponent(getClient());
}

function customersMessageTemplatesUrl(suffix) {
  return '/staff/customers/message-templates' + (suffix || '') + '?client=' + encodeURIComponent(getClient());
}

function findCustomerMessageTemplate(id) {
  for (var i = 0; i < customersOutreachTemplatesCache.length; i++) {
    if (customersOutreachTemplatesCache[i].id === id) return customersOutreachTemplatesCache[i];
  }
  return null;
}

function renderCustomerMessageTemplatesPicker() {
  var select = el('cust-outreach-template-select');
  var list = el('cust-outreach-template-list');
  if (!select || !list) return;
  var opts = '<option value="">' + escHtml(portalT('customers.templates.pickPlaceholder')) + '</option>';
  customersOutreachTemplatesCache.forEach(function(t) {
    opts += '<option value="' + escHtml(t.id) + '">' + escHtml(t.title) + '</option>';
  });
  select.innerHTML = opts;
  if (!customersOutreachTemplatesCache.length) {
    list.innerHTML = '<p class="customers-outreach-warn-muted">' + escHtml(portalT('customers.templates.empty')) + '</p>';
    return;
  }
  list.innerHTML = customersOutreachTemplatesCache.map(function(t) {
    return '<div class="customers-outreach-template-item" data-template-id="' + escHtml(t.id) + '">' +
      '<span class="customers-outreach-template-item-title">' + escHtml(t.title) + '</span>' +
      '<button type="button" class="btn btn-ghost cust-template-apply" data-template-id="' + escHtml(t.id) + '">' + escHtml(portalT('customers.templates.apply')) + '</button>' +
      '<button type="button" class="btn btn-ghost cust-template-edit" data-template-id="' + escHtml(t.id) + '">' + escHtml(portalT('customers.templates.edit')) + '</button>' +
      '<button type="button" class="btn btn-ghost cust-template-delete" data-template-id="' + escHtml(t.id) + '">' + escHtml(portalT('customers.templates.delete')) + '</button>' +
      '</div>';
  }).join('');
}

function loadCustomerMessageTemplates() {
  var list = el('cust-outreach-template-list');
  if (list) list.innerHTML = '<p class="customers-outreach-warn-muted">' + escHtml(portalT('customers.templates.loading')) + '</p>';
  return fetch(customersMessageTemplatesUrl())
    .then(function(r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
    .then(function(data) {
      customersOutreachTemplatesCache = (data && data.templates) || [];
      renderCustomerMessageTemplatesPicker();
    })
    .catch(function() {
      customersOutreachTemplatesCache = [];
      renderCustomerMessageTemplatesPicker();
      var msg = el('cust-outreach-template-msg');
      if (msg) { msg.className = 'state-msg error'; msg.textContent = portalT('customers.templates.loadFailed'); msg.style.display = 'block'; }
    });
}

function applyCustomerMessageTemplateBody(body) {
  var msg = el('cust-outreach-message');
  if (msg && body) msg.value = body;
  updateCustomersOutreachSendButton();
}

function customersOutreachGenerateUrl() {
  return '/staff/customers/message-templates/generate?client=' + encodeURIComponent(getClient());
}

function setCustomersOutreachComposeMode(mode) {
  customersOutreachComposeMode = mode === 'notes' ? 'notes' : 'message';
  var msgPanel = el('cust-outreach-message-panel');
  var notesPanel = el('cust-outreach-notes-panel');
  var msgBtn = el('cust-outreach-mode-message');
  var notesBtn = el('cust-outreach-mode-notes');
  if (notesPanel) notesPanel.style.display = customersOutreachComposeMode === 'notes' ? '' : 'none';
  if (msgPanel) msgPanel.style.display = '';
  if (msgBtn) msgBtn.classList.toggle('active', customersOutreachComposeMode === 'message');
  if (notesBtn) notesBtn.classList.toggle('active', customersOutreachComposeMode === 'notes');
  updateCustomersOutreachGenerateButton();
}

function updateCustomersOutreachGenerateButton() {
  var btn = el('cust-outreach-generate');
  if (!btn) return;
  btn.textContent = portalT(customersOutreachHasGeneratedDraft ? 'customers.outreach.regenerate' : 'customers.outreach.generate');
}

function showCustomersOutreachGenerateMsg(text, isError) {
  var msg = el('cust-outreach-generate-msg');
  if (!msg) return;
  msg.className = isError ? 'state-msg error' : 'state-msg';
  msg.textContent = text;
  msg.style.display = text ? 'block' : 'none';
}

function generateCustomerOutreachDraftFromNotes() {
  var notesEl = el('cust-outreach-notes');
  var notes = (notesEl && notesEl.value || '').trim();
  if (!notes) {
    showCustomersOutreachGenerateMsg(portalT('customers.outreach.notesRequired'), true);
    return;
  }
  showCustomersOutreachGenerateMsg('', false);
  var plan = buildCustomersOutreachPlan();
  var payload = {
    notes: notes,
    recipient_count: plan.recipients.length,
    recipient_names: plan.recipients.map(function(r) { return r.name; }),
  };
  var btn = el('cust-outreach-generate');
  if (btn) {
    btn.disabled = true;
    btn.textContent = portalT('customers.outreach.generating');
  }
  fetch(customersOutreachGenerateUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
    .then(function(r) { return r.json().then(function(data) { return { ok: r.ok, data: data }; }); })
    .then(function(res) {
      if (!res.ok || !res.data || !res.data.success || !res.data.body) {
        throw new Error((res.data && (res.data.detail || res.data.error)) || 'generate failed');
      }
      applyCustomerMessageTemplateBody(res.data.body);
      customersOutreachHasGeneratedDraft = true;
      showCustomersOutreachGenerateMsg('', false);
    })
    .catch(function(err) {
      showCustomersOutreachGenerateMsg(portalT('customers.outreach.generateFailed') + ' ' + err.message, true);
    })
    .finally(function() {
      if (btn) btn.disabled = false;
      updateCustomersOutreachGenerateButton();
    });
}

function applySelectedCustomerMessageTemplate() {
  var select = el('cust-outreach-template-select');
  if (!select || !select.value) return;
  var t = findCustomerMessageTemplate(select.value);
  if (t) applyCustomerMessageTemplateBody(t.body);
}

function beginEditCustomerMessageTemplate(id) {
  var t = findCustomerMessageTemplate(id);
  if (!t) return;
  customersOutreachTemplateEditingId = id;
  var titleEl = el('cust-outreach-template-title');
  var cancelBtn = el('cust-outreach-template-cancel-edit');
  var saveBtn = el('cust-outreach-template-save');
  if (titleEl) titleEl.value = t.title;
  applyCustomerMessageTemplateBody(t.body);
  if (cancelBtn) cancelBtn.style.display = '';
  if (saveBtn) saveBtn.textContent = portalT('customers.templates.update');
}

function cancelEditCustomerMessageTemplate() {
  customersOutreachTemplateEditingId = null;
  var titleEl = el('cust-outreach-template-title');
  var cancelBtn = el('cust-outreach-template-cancel-edit');
  var saveBtn = el('cust-outreach-template-save');
  if (titleEl) titleEl.value = '';
  if (cancelBtn) cancelBtn.style.display = 'none';
  if (saveBtn) saveBtn.textContent = portalT('customers.templates.saveAs');
}

function showCustomerTemplateMsg(text, isError) {
  var msg = el('cust-outreach-template-msg');
  if (!msg) return;
  msg.className = isError ? 'state-msg error' : 'state-msg';
  msg.textContent = text;
  msg.style.display = text ? 'block' : 'none';
}

function saveCustomerMessageTemplateFromDraft() {
  var titleEl = el('cust-outreach-template-title');
  var msgEl = el('cust-outreach-message');
  var saveBtn = el('cust-outreach-template-save');
  var title = (titleEl && titleEl.value || '').trim();
  var body = (msgEl && msgEl.value || '').trim();
  if (!title || !body) {
    showCustomerTemplateMsg(portalT('customers.templates.saveRequired'), true);
    return;
  }
  showCustomerTemplateMsg('', false);
  var editing = customersOutreachTemplateEditingId;
  var url = editing ? customersMessageTemplatesUrl('/' + encodeURIComponent(editing)) : customersMessageTemplatesUrl();
  var method = editing ? 'PATCH' : 'POST';
  var payload = editing ? { title: title, body: body } : { title: title, body: body, channel: 'whatsapp' };
  if (saveBtn) saveBtn.disabled = true;
  fetch(url, { method: method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    .then(function(r) { return r.json().then(function(data) { return { ok: r.ok, data: data }; }); })
    .then(function(res) {
      if (!res.ok || !res.data || !res.data.success) throw new Error((res.data && res.data.error) || 'save failed');
      cancelEditCustomerMessageTemplate();
      return loadCustomerMessageTemplates();
    })
    .then(function() { showCustomerTemplateMsg(portalT('customers.templates.saved'), false); })
    .catch(function(err) { showCustomerTemplateMsg(portalT('customers.templates.saveFailed') + ' ' + err.message, true); })
    .finally(function() { if (saveBtn) saveBtn.disabled = false; });
}

function deleteCustomerMessageTemplate(id) {
  if (!id) return;
  if (!window.confirm(portalT('customers.templates.deleteConfirm'))) return;
  fetch(customersMessageTemplatesUrl('/' + encodeURIComponent(id)), { method: 'DELETE' })
    .then(function(r) { return r.json().then(function(data) { return { ok: r.ok, data: data }; }); })
    .then(function(res) {
      if (!res.ok || !res.data || !res.data.success) throw new Error((res.data && res.data.error) || 'delete failed');
      if (customersOutreachTemplateEditingId === id) cancelEditCustomerMessageTemplate();
      return loadCustomerMessageTemplates();
    })
    .then(function() { showCustomerTemplateMsg(portalT('customers.templates.deleted'), false); })
    .catch(function(err) { showCustomerTemplateMsg(portalT('customers.templates.deleteFailed') + ' ' + err.message, true); });
}

function updateCustomersOutreachSendButton() {
  var btn = el('cust-outreach-send');
  if (!btn) return;
  var msgEl = el('cust-outreach-message');
  var message = (msgEl && msgEl.value || '').trim();
  var plan = buildCustomersOutreachPlan();
  btn.disabled = !(message.length >= CUSTOMERS_OUTREACH_MESSAGE_MIN && plan.recipients.length > 0);
}

function closeCustomersOutreachConfirmModal() {
  var modal = el('cust-outreach-confirm-modal');
  if (modal) { modal.style.display = 'none'; modal.setAttribute('aria-hidden', 'true'); }
  var msg = el('cust-outreach-confirm-msg');
  if (msg) { msg.style.display = 'none'; msg.textContent = ''; }
}

function openCustomersOutreachConfirmModal() {
  var msgEl = el('cust-outreach-message');
  var message = (msgEl && msgEl.value || '').trim();
  if (message.length < CUSTOMERS_OUTREACH_MESSAGE_MIN) {
    return;
  }
  var plan = buildCustomersOutreachPlan();
  if (!plan.recipients.length) return;
  closeCustomersOutreachDrawer();
  var stats = el('cust-outreach-confirm-stats');
  var skipped = el('cust-outreach-confirm-skipped');
  var preview = el('cust-outreach-confirm-preview');
  if (stats) {
    stats.textContent = portalT('customers.outreach.confirmEligible').replace('{count}', String(plan.recipients.length))
      + ' · ' + portalT('customers.outreach.confirmSkipped').replace('{count}', String(plan.skippedNoPhone.length + plan.skippedDnc.length));
  }
  if (skipped) {
    var lines = [];
    plan.skippedNoPhone.forEach(function(r) {
      lines.push(portalT('customers.outreach.skippedNoPhone') + ': ' + r.name);
    });
    plan.skippedDnc.forEach(function(r) {
      lines.push(portalT('customers.outreach.skippedDnc') + ': ' + r.name);
    });
    skipped.textContent = lines.join('\n');
    skipped.style.display = lines.length ? 'block' : 'none';
  }
  if (preview) preview.textContent = message;
  var modal = el('cust-outreach-confirm-modal');
  if (modal) { modal.style.display = 'flex'; modal.setAttribute('aria-hidden', 'false'); }
}

function renderCustomersOutreachResults(results) {
  var host = el('cust-outreach-results');
  if (!host) return;
  if (!results || !results.length) {
    host.innerHTML = '';
    host.style.display = 'none';
    return;
  }
  var html = '<div class="customers-outreach-section"><div class="customers-outreach-section-hdr">' + escHtml(portalT('customers.outreach.resultsTitle')) + '</div>';
  results.forEach(function(row) {
    var cls = 'customers-outreach-result-row ';
    var label = row.status;
    if (row.status === 'sent') { cls += 'customers-outreach-result-sent'; label = portalT('customers.outreach.resultSent'); }
    else if (row.status === 'skipped') { cls += 'customers-outreach-result-skipped'; label = portalT('customers.outreach.resultSkipped'); }
    else { cls += 'customers-outreach-result-error'; label = portalT('customers.outreach.resultError'); }
    var detail = row.name || row.phone || '';
    if (row.reason) detail += (detail ? ' — ' : '') + row.reason;
    html += '<div class="' + cls + '"><strong>' + escHtml(label) + '</strong> ' + escHtml(detail) + '</div>';
  });
  html += '</div>';
  host.innerHTML = html;
  host.style.display = 'block';
}

function executeCustomersOutreachSend() {
  var msgEl = el('cust-outreach-message');
  var message = (msgEl && msgEl.value || '').trim();
  var plan = buildCustomersOutreachPlan();
  if (message.length < CUSTOMERS_OUTREACH_MESSAGE_MIN || !plan.recipients.length) return;
  var confirmBtn = el('cust-outreach-confirm-send');
  var confirmMsg = el('cust-outreach-confirm-msg');
  if (confirmBtn) confirmBtn.disabled = true;
  if (confirmMsg) { confirmMsg.style.display = 'none'; confirmMsg.textContent = ''; }
  fetch(customersOutreachSendUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      confirmed: true,
      channel: 'whatsapp',
      message: message,
      phones: plan.recipients.map(function(r) { return r.phone; }),
    }),
  })
    .then(function(r) { return r.json().then(function(data) { return { ok: r.ok, data: data }; }); })
    .then(function(res) {
      if (!res.ok || !res.data || !res.data.success) {
        throw new Error((res.data && (res.data.detail || res.data.error)) || 'send failed');
      }
      closeCustomersOutreachConfirmModal();
      renderCustomersOutreachResults(res.data.results || []);
      var sendMsg = el('cust-outreach-send-msg');
      if (sendMsg) {
        sendMsg.className = 'state-msg';
        sendMsg.textContent = portalT('customers.outreach.sendComplete');
        sendMsg.style.display = 'block';
      }
    })
    .catch(function(err) {
      if (confirmMsg) {
        confirmMsg.className = 'state-msg error';
        confirmMsg.textContent = portalT('customers.outreach.sendFailed') + ' ' + err.message;
        confirmMsg.style.display = 'block';
      }
    })
    .finally(function() { if (confirmBtn) confirmBtn.disabled = false; });
}

function wireCustomersOutreachSendActions() {
  var sendBtn = el('cust-outreach-send');
  if (sendBtn && !sendBtn.dataset.wired) {
    sendBtn.dataset.wired = '1';
    sendBtn.addEventListener('click', function() { openCustomersOutreachConfirmModal(); });
  }
  var confirmSend = el('cust-outreach-confirm-send');
  if (confirmSend && !confirmSend.dataset.wired) {
    confirmSend.dataset.wired = '1';
    confirmSend.addEventListener('click', function() { executeCustomersOutreachSend(); });
  }
  var confirmCancel = el('cust-outreach-confirm-cancel');
  if (confirmCancel && !confirmCancel.dataset.wired) {
    confirmCancel.dataset.wired = '1';
    confirmCancel.addEventListener('click', function() { closeCustomersOutreachConfirmModal(); });
  }
  var confirmBackdrop = el('cust-outreach-confirm-backdrop');
  if (confirmBackdrop && !confirmBackdrop.dataset.wired) {
    confirmBackdrop.dataset.wired = '1';
    confirmBackdrop.addEventListener('click', function() { closeCustomersOutreachConfirmModal(); });
  }
}

function wireCustomersOutreachTemplateActions() {
  var applyBtn = el('cust-outreach-template-apply');
  if (applyBtn) applyBtn.onclick = function() { applySelectedCustomerMessageTemplate(); };
  var saveBtn = el('cust-outreach-template-save');
  if (saveBtn) saveBtn.onclick = function() { saveCustomerMessageTemplateFromDraft(); };
  var cancelBtn = el('cust-outreach-template-cancel-edit');
  if (cancelBtn) cancelBtn.onclick = function() { cancelEditCustomerMessageTemplate(); };
  var msgBtn = el('cust-outreach-mode-message');
  if (msgBtn) msgBtn.onclick = function() { setCustomersOutreachComposeMode('message'); };
  var notesBtn = el('cust-outreach-mode-notes');
  if (notesBtn) notesBtn.onclick = function() { setCustomersOutreachComposeMode('notes'); };
  var genBtn = el('cust-outreach-generate');
  if (genBtn) genBtn.onclick = function() { generateCustomerOutreachDraftFromNotes(); };
}

function wireCustomersOutreachDrawer() {
  var openBtn = el('cust-message-selected-btn');
  if (openBtn && !openBtn.dataset.wired) {
    openBtn.dataset.wired = '1';
    openBtn.addEventListener('click', function() { openCustomersOutreachDrawer(); });
  }
  var closeBtn = el('cust-outreach-close');
  if (closeBtn && !closeBtn.dataset.wired) {
    closeBtn.dataset.wired = '1';
    closeBtn.addEventListener('click', function() { closeCustomersOutreachDrawer(); });
  }
  var backdrop = el('cust-outreach-backdrop');
  if (backdrop && !backdrop.dataset.wired) {
    backdrop.dataset.wired = '1';
    backdrop.addEventListener('click', function() { closeCustomersOutreachDrawer(); });
  }
  wireCustomersOutreachSendActions();
  var drawer = el('customers-outreach-drawer');
  if (drawer && !drawer.dataset.templatesWired) {
    drawer.dataset.templatesWired = '1';
    drawer.addEventListener('click', function(ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('button[data-template-id]') : null;
      if (!btn) return;
      var id = btn.getAttribute('data-template-id');
      if (btn.classList.contains('cust-template-apply')) {
        var t = findCustomerMessageTemplate(id);
        if (t) applyCustomerMessageTemplateBody(t.body);
      } else if (btn.classList.contains('cust-template-edit')) {
        beginEditCustomerMessageTemplate(id);
      } else if (btn.classList.contains('cust-template-delete')) {
        deleteCustomerMessageTemplate(id);
      }
    });
  }
}

function renderCustomersOutreachDrawer() {
  var body = el('cust-outreach-body');
  if (!body) return;
  var plan = buildCustomersOutreachPlan();
  var html = '';
  html += '<div class="customers-outreach-section"><div class="customers-outreach-section-hdr">' + escHtml(portalT('customers.outreach.recipients')) + '</div>';
  if (plan.recipients.length) {
    plan.recipients.forEach(function(r) {
      html += '<div class="customers-outreach-recipient"><strong>' + escHtml(r.name) + '</strong><br>' + escHtml(r.phone) + '</div>';
    });
  } else {
    html += '<p class="customers-outreach-warn-muted">' + escHtml(portalT('customers.outreach.noRecipients')) + '</p>';
  }
  html += '</div>';
  if (plan.skippedNoPhone.length || plan.skippedDnc.length) {
    html += '<div class="customers-outreach-section"><div class="customers-outreach-section-hdr">' + escHtml(portalT('customers.outreach.skipped')) + '</div>';
    plan.skippedNoPhone.forEach(function(r) {
      html += '<div class="customers-outreach-warn">' + escHtml(portalT('customers.outreach.skippedNoPhone')) + ': ' + escHtml(r.name) + '</div>';
    });
    plan.skippedDnc.forEach(function(r) {
      html += '<div class="customers-outreach-warn">' + escHtml(portalT('customers.outreach.skippedDnc')) + ': ' + escHtml(r.name) + ' (' + escHtml(r.phone) + ')</div>';
    });
    html += '</div>';
  }
  html += '<div class="customers-outreach-section">';
  html += '<div class="customers-outreach-mode-toggle" role="tablist" aria-label="' + escHtml(portalT('customers.outreach.messageLabel')) + '">';
  html += '<button type="button" class="customers-outreach-mode-btn" id="cust-outreach-mode-message" role="tab">' + escHtml(portalT('customers.outreach.modeMessage')) + '</button>';
  html += '<button type="button" class="customers-outreach-mode-btn" id="cust-outreach-mode-notes" role="tab">' + escHtml(portalT('customers.outreach.modeNotes')) + '</button>';
  html += '</div>';
  html += '<div id="cust-outreach-notes-panel" class="customers-outreach-notes-panel" style="display:none">';
  html += '<label class="customers-edit-field" for="cust-outreach-notes"><span>' + escHtml(portalT('customers.outreach.notesLabel')) + '</span></label>';
  html += '<textarea id="cust-outreach-notes" class="customers-outreach-textarea" data-i18n-placeholder="customers.outreach.notesPlaceholder" placeholder="What should Luna say? Bullet points are fine…"></textarea>';
  html += '<div class="customers-outreach-generate-row"><button type="button" class="btn btn-primary" id="cust-outreach-generate">' + escHtml(portalT('customers.outreach.generate')) + '</button></div>';
  html += '<p id="cust-outreach-generate-msg" class="state-msg" style="display:none;margin-top:8px"></p>';
  html += '</div>';
  html += '<div id="cust-outreach-message-panel"><label class="customers-edit-field" for="cust-outreach-message"><span>' + escHtml(portalT('customers.outreach.messageLabel')) + '</span></label>';
  html += '<textarea id="cust-outreach-message" class="customers-outreach-textarea" data-i18n-placeholder="customers.outreach.messagePlaceholder" placeholder="Type your message…"></textarea></div>';
  html += '</div>';
  html += '<div class="customers-outreach-section" id="cust-outreach-templates-section">';
  html += '<div class="customers-outreach-section-hdr">' + escHtml(portalT('customers.outreach.cannedTitle')) + '</div>';
  html += '<div class="customers-outreach-template-toolbar">';
  html += '<select id="cust-outreach-template-select" class="customers-outreach-template-select" aria-label="' + escHtml(portalT('customers.templates.pickPlaceholder')) + '"></select>';
  html += '<button type="button" class="btn btn-ghost" id="cust-outreach-template-apply">' + escHtml(portalT('customers.templates.apply')) + '</button>';
  html += '</div>';
  html += '<div id="cust-outreach-template-list" class="customers-outreach-template-list"></div>';
  html += '<div class="customers-outreach-template-save">';
  html += '<input id="cust-outreach-template-title" type="text" data-i18n-placeholder="customers.templates.titlePlaceholder" placeholder="Template title">';
  html += '<button type="button" class="btn btn-primary" id="cust-outreach-template-save">' + escHtml(portalT('customers.templates.saveAs')) + '</button>';
  html += '<button type="button" class="btn btn-ghost" id="cust-outreach-template-cancel-edit" style="display:none">' + escHtml(portalT('customers.cancel')) + '</button>';
  html += '</div>';
  html += '<p id="cust-outreach-template-msg" class="state-msg" style="display:none;margin-top:8px"></p></div>';
  html += '<div id="cust-outreach-results" class="customers-outreach-results" style="display:none"></div>';
  html += '<p id="cust-outreach-send-msg" class="state-msg" style="display:none;margin-top:8px"></p>';
  body.innerHTML = html;
  var msg = el('cust-outreach-message');
  if (msg) {
    msg.setAttribute('placeholder', portalT('customers.outreach.messagePlaceholder'));
    msg.addEventListener('input', updateCustomersOutreachSendButton);
  }
  var notes = el('cust-outreach-notes');
  if (notes) notes.setAttribute('placeholder', portalT('customers.outreach.notesPlaceholder'));
  setCustomersOutreachComposeMode(customersOutreachComposeMode);
  updateCustomersOutreachSendButton();
  var titleInput = el('cust-outreach-template-title');
  if (titleInput) titleInput.setAttribute('placeholder', portalT('customers.templates.titlePlaceholder'));
}

function openCustomersOutreachDrawer() {
  if (getCustomersBulkSelectedPhones().length < 1) return;
  customersOutreachTemplateEditingId = null;
  customersOutreachComposeMode = 'message';
  customersOutreachHasGeneratedDraft = false;
  renderCustomersOutreachDrawer();
  wireCustomersOutreachTemplateActions();
  loadCustomerMessageTemplates();
  var backdrop = el('cust-outreach-backdrop');
  var drawer = el('customers-outreach-drawer');
  if (backdrop) { backdrop.classList.add('open'); backdrop.setAttribute('aria-hidden', 'false'); }
  if (drawer) { drawer.classList.add('open'); drawer.setAttribute('aria-hidden', 'false'); }
}

function closeCustomersOutreachDrawer() {
  var backdrop = el('cust-outreach-backdrop');
  var drawer = el('customers-outreach-drawer');
  if (backdrop) { backdrop.classList.remove('open'); backdrop.setAttribute('aria-hidden', 'true'); }
  if (drawer) { drawer.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true'); }
}

function customerTagChipHtml(tagKey, opts) {
  opts = opts || {};
  var isAuto = !!opts.auto;
  var cls = 'customers-badge';
  if (tagKey === 'hot_lead') cls += ' customers-badge-booked';
  else if (tagKey === 'warm_lead') cls += ' customers-badge-warm';
  else if (tagKey === 'surf_school') cls += ' customers-badge-lesson';
  else if (tagKey === 'rental') cls += ' customers-badge-rental';
  else if (tagKey === 'needs_attention') cls += ' customers-badge-attn';
  else if (tagKey === 'do_not_contact') cls += ' customers-badge-dnc';
  else cls += ' customers-badge-tag';
  if (isAuto && !opts.compact) cls += ' customers-badge-auto';
  var label = portalT('customers.tags.' + tagKey) || tagKey;
  var title = isAuto ? portalT('customers.tags.autoTitle') : '';
  return '<span class="' + cls + '"' + (title ? ' title="' + escHtml(title) + '"' : '') + '>' + escHtml(label) + '</span>';
}
