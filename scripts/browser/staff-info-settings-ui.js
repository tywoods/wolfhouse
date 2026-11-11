/* Staff Info — collapsed Luna Staff section: staff member name for guest handoff notes. */
/* global document, fetch, getClient, t, staffWhatsappNumberQuery */

function staffInfoT(key, fallback) {
  try {
    if (typeof t === 'function') {
      var packed = t(key);
      if (packed && packed !== key) return packed;
    }
  } catch (_e) { /* pack unavailable */ }
  return fallback;
}

function staffInfoClient() {
  try {
    if (typeof getClient === 'function') return getClient();
  } catch (_error) { /* selected client is unavailable */ }
  return '';
}

function applyStaffInfoI18n() {
  var title = document.querySelector('#cc-staff-info .cc-section-hdr');
  if (title) title.textContent = staffInfoT('lunaStaff.info.title', 'Staff Info');
  var sub = document.querySelector('#cc-staff-info .cc-section-sub');
  if (sub) sub.textContent = staffInfoT('lunaStaff.info.sub', 'Shown to guests on a warm handoff note.');
  var label = document.querySelector('label[for="staff-info-name"]');
  if (label) label.textContent = staffInfoT('lunaStaff.info.name', 'Staff member name');
  var save = document.getElementById('staff-info-save-btn');
  if (save) save.textContent = staffInfoT('lunaStaff.info.save', 'Save');
}

function ensureStaffInfoCard() {
  var host = document.getElementById('al-wrap');
  var notes = document.getElementById('cc-house-notes');
  if (!host || !notes) return null;
  var existing = document.getElementById('cc-staff-info');
  if (existing) {
    applyStaffInfoI18n();
    return existing;
  }
  var card = document.createElement('div');
  card.className = 'card cc-section';
  card.id = 'cc-staff-info';
  card.innerHTML =
    '<div class="cc-section-hdr">Staff Info</div>' +
    '<div class="cc-section-sub">Shown to guests on a warm handoff note.</div>' +
    '<div id="staff-info-error"></div>' +
    '<div id="staff-info-status"></div>' +
    '<label for="staff-info-name">Staff member name</label>' +
    '<input id="staff-info-name" type="text" maxlength="60" autocomplete="name" placeholder="Camila">' +
    '<div class="al-form-row" style="margin-top:8px">' +
      '<button class="btn btn-primary" type="button" id="staff-info-save-btn">Save</button>' +
    '</div>';
  host.insertBefore(card, notes);
  var body = document.createElement('div');
  body.id = 'cc-staff-info-body';
  body.className = 'staff-collapse-body portal-admin-section-body';
  var title = card.firstElementChild;
  var button = document.createElement('button');
  button.type = 'button';
  button.id = 'staff-info-toggle';
  button.className = 'staff-collapse-toggle portal-admin-section-hdr';
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', body.id);
  card.insertBefore(button, title);
  button.appendChild(title);
  var caret = document.createElement('span');
  caret.className = 'staff-collapse-caret';
  caret.setAttribute('aria-hidden', 'true');
  button.appendChild(caret);
  Array.prototype.slice.call(card.childNodes).forEach(function (node) {
    if (node !== button) body.appendChild(node);
  });
  card.appendChild(body);
  body.hidden = true;
  button.addEventListener('click', function () {
    var open = button.getAttribute('aria-expanded') === 'true';
    button.setAttribute('aria-expanded', open ? 'false' : 'true');
    body.hidden = open;
  });
  var saveBtn = document.getElementById('staff-info-save-btn');
  if (saveBtn) saveBtn.addEventListener('click', saveStaffInfoSettings);
  applyStaffInfoI18n();
  return card;
}

function staffInfoQuery() {
  try {
    if (typeof staffWhatsappNumberQuery === 'function') return staffWhatsappNumberQuery();
  } catch (_e) { /* ignore */ }
  var client = staffInfoClient();
  return client ? ('?client=' + encodeURIComponent(client)) : '';
}

function loadStaffInfoSettings() {
  var card = ensureStaffInfoCard();
  if (!card) return;
  var status = document.getElementById('staff-info-status');
  fetch('/staff/staff-info' + staffInfoQuery(), { credentials: 'same-origin' })
    .then(function (res) { return res.json(); })
    .then(function (body) {
      var input = document.getElementById('staff-info-name');
      if (input) input.value = (body && body.staff_member_name) || '';
      if (status) status.textContent = '';
    })
    .catch(function () {
      if (status) status.textContent = staffInfoT('lunaStaff.info.loadFailed', 'Could not load');
    });
}

function saveStaffInfoSettings() {
  var input = document.getElementById('staff-info-name');
  var status = document.getElementById('staff-info-status');
  var name = input ? String(input.value || '').trim() : '';
  fetch('/staff/staff-info' + staffInfoQuery(), {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ staff_member_name: name }),
  })
    .then(function (res) { return res.json(); })
    .then(function (body) {
      if (input) input.value = (body && body.staff_member_name) || '';
      if (status) status.textContent = staffInfoT('lunaStaff.info.saved', 'Saved');
    })
    .catch(function () {
      if (status) status.textContent = staffInfoT('lunaStaff.info.saveFailed', 'Could not save');
    });
}
