/* Wolfhouse Staff — wetsuit promo and staff access code. Wolfhouse only. */
/* global document, fetch, getClient, t */

function whStaffFieldsT(key, fallback) {
  try {
    if (typeof t === 'function') {
      var packed = t(key);
      if (packed && packed !== key) return packed;
    }
  } catch (_e) { /* pack unavailable */ }
  return fallback;
}

function applyWolfhouseStaffPortalFieldsI18n() {
  var promo = document.querySelector('#wh-wetsuit-promo-card .portal-admin-section-hdr-title');
  if (promo) promo.textContent = whStaffFieldsT('lunaStaff.wetsuitPromo.title', 'Wetsuit promo');
  var code = document.querySelector('#wh-staff-access-code-card .portal-admin-section-hdr-title');
  if (code) code.textContent = whStaffFieldsT('lunaStaff.accessCode.title', 'Staff access code');
}

function wolfhouseStaffPortalFieldsStatus(node, message, isError, reveal) {
  if (!node) return;
  node.textContent = message || '';
  node.classList.toggle('is-error', !!isError);
  if (reveal && isError && window.staffCollapseReveal) window.staffCollapseReveal(node);
}

function wolfhouseStaffPortalClient() {
  try {
    if (typeof getClient === 'function') return getClient();
  } catch (_error) { /* selected client is unavailable */ }
  return '';
}

function clearWolfhouseStaffPortalFields() {
  var code = document.getElementById('wh-staff-access-code');
  if (code) {
    code.value = '';
    code.setAttribute('data-configured', 'false');
  }
  var promo = document.getElementById('wh-wetsuit-promo-text');
  if (promo) promo.value = '';
  var wrap = document.getElementById('wh-staff-portal-fields');
  if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap);
}

function ensureWolfhouseStaffPortalFields() {
  var host = document.getElementById('al-wrap');
  var notes = document.getElementById('cc-house-notes');
  if (!host || !notes) return null;
  var existing = document.getElementById('wh-staff-portal-fields');
  if (existing) {
    applyWolfhouseStaffPortalFieldsI18n();
    return existing;
  }

  var wrap = document.createElement('div');
  wrap.id = 'wh-staff-portal-fields';
  wrap.className = 'wh-staff-portal-fields';
  wrap.innerHTML =
    '<section class="portal-admin-section" id="wh-wetsuit-promo-card">' +
      '<div class="portal-admin-section-hdr"><div class="portal-admin-section-hdr-title">Wetsuit promo</div></div>' +
      '<div class="portal-admin-edit-form wh-spf-form">' +
        '<div class="portal-admin-edit-field wh-spf-wide">' +
          '<label for="wh-wetsuit-promo-text">Offer text</label>' +
          '<textarea id="wh-wetsuit-promo-text" rows="3" maxlength="500" aria-describedby="wh-wetsuit-promo-help"></textarea>' +
          '<div class="portal-admin-muted" id="wh-wetsuit-promo-help">Guest-shareable offer. Luna reads this text. Do not put private notes here.</div>' +
        '</div>' +
        '<div class="portal-admin-edit-actions"><span class="portal-admin-muted wh-spf-status" id="wh-wetsuit-promo-status" role="status"></span><button type="button" class="btn btn-primary" id="wh-wetsuit-promo-save">Save</button></div>' +
      '</div>' +
    '</section>' +
    '<section class="portal-admin-section" id="wh-staff-access-code-card">' +
      '<div class="portal-admin-section-hdr"><div class="portal-admin-section-hdr-title">Staff access code</div></div>' +
      '<div class="portal-admin-edit-form wh-spf-form">' +
        '<div class="portal-admin-edit-field wh-spf-wide">' +
          '<label for="wh-staff-access-code">Arrival code</label>' +
          '<input id="wh-staff-access-code" type="password" autocomplete="off" spellcheck="false" autocapitalize="off" maxlength="64" aria-describedby="wh-staff-access-code-help">' +
          '<div class="portal-admin-muted" id="wh-staff-access-code-help">Hidden in the page. Clear and save to remove it. Not sent to guests from this card.</div>' +
        '</div>' +
        '<div class="portal-admin-edit-actions"><span class="portal-admin-muted wh-spf-status" id="wh-staff-access-code-status" role="status"></span><button type="button" class="btn btn-primary" id="wh-staff-access-code-save">Save</button></div>' +
      '</div>' +
    '</section>';

  if (!document.getElementById('wh-staff-portal-fields-css')) {
    var style = document.createElement('style');
    style.id = 'wh-staff-portal-fields-css';
    style.textContent =
      '#wh-staff-portal-fields{display:grid;gap:14px;width:100%;max-width:100%;font-family:var(--font-sans)}' +
      '#wh-staff-portal-fields .portal-admin-section-hdr-title{font-weight:700;text-transform:none}' +
      '#wh-staff-portal-fields .wh-spf-form{display:grid;grid-template-columns:minmax(0,1fr);align-items:end}' +
      '#wh-staff-portal-fields .wh-spf-wide,#wh-staff-portal-fields .portal-admin-edit-actions{grid-column:1/-1}' +
      '#wh-staff-portal-fields textarea,#wh-staff-portal-fields input{width:100%;max-width:none;box-sizing:border-box;min-height:40px}' +
      '#wh-staff-portal-fields textarea{min-height:72px;resize:vertical}' +
      '#wh-staff-portal-fields .portal-admin-edit-actions{display:flex;justify-content:space-between;gap:8px;align-items:center}' +
      '#wh-staff-portal-fields .wh-spf-status.is-error{color:var(--danger,#a33)}' +
      '@media(max-width:640px){#wh-staff-portal-fields .portal-admin-edit-actions{flex-wrap:wrap}}';
    (document.head || document.documentElement).appendChild(style);
  }

  var anchor = document.getElementById('wh-location-booking-settings');
  if (anchor && anchor.parentNode) anchor.insertAdjacentElement('afterend', wrap);
  else host.insertBefore(wrap, notes.nextSibling);
  applyWolfhouseStaffPortalFieldsI18n();
  return wrap;
}

function loadWolfhouseStaffPortalFields() {
  if (wolfhouseStaffPortalClient() !== 'wolfhouse-somo') {
    clearWolfhouseStaffPortalFields();
    return Promise.resolve(null);
  }
  var wrap = ensureWolfhouseStaffPortalFields();
  if (!wrap) return Promise.resolve(null);
  if (typeof window.staffCollapseEnhanceLate === 'function') {
    window.staffCollapseEnhanceLate('wh-wetsuit-promo-card', 'wh-wetsuit-promo-toggle');
    window.staffCollapseEnhanceLate('wh-staff-access-code-card', 'wh-staff-access-code-toggle');
  }
  var promo = document.getElementById('wh-wetsuit-promo-text');
  var promoStatus = document.getElementById('wh-wetsuit-promo-status');
  var promoSave = document.getElementById('wh-wetsuit-promo-save');
  var code = document.getElementById('wh-staff-access-code');
  var codeStatus = document.getElementById('wh-staff-access-code-status');
  var codeSave = document.getElementById('wh-staff-access-code-save');
  if (!promo || !code || wrap._wolfhouseFieldsWired) {
    return refreshWolfhouseStaffPortalFields(wrap);
  }
  wrap._wolfhouseFieldsWired = true;

  function put(path, body, statusNode) {
    var client = wolfhouseStaffPortalClient();
    if (client !== 'wolfhouse-somo') {
      wolfhouseStaffPortalFieldsStatus(statusNode, whStaffFieldsT('lunaStaff.fields.saveFailed', 'Could not save.'), true, true);
      return Promise.resolve(false);
    }
    var scoped = path + (path.indexOf('?') === -1 ? '?' : '&') + 'client=' + encodeURIComponent(client);
    wolfhouseStaffPortalFieldsStatus(statusNode, whStaffFieldsT('lunaStaff.fields.saving', 'Saving…'), false);
    return fetch(scoped, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    }).then(function (response) {
      return response.json().then(function (payload) {
        return { ok: response.ok, payload: payload };
      }).catch(function () {
        return { ok: false, payload: null };
      });
    }).then(function (result) {
      if (!result.ok) {
        wolfhouseStaffPortalFieldsStatus(statusNode, whStaffFieldsT('lunaStaff.fields.saveFailed', 'Could not save.'), true, true);
        return false;
      }
      wolfhouseStaffPortalFieldsStatus(statusNode, whStaffFieldsT('lunaStaff.fields.saved', 'Saved.'), false, false);
      return true;
    }).catch(function () {
      wolfhouseStaffPortalFieldsStatus(statusNode, whStaffFieldsT('lunaStaff.fields.saveFailed', 'Could not save.'), true, true);
      return false;
    });
  }

  promoSave.addEventListener('click', function () {
    put('/staff/admin/wetsuit-promo', { text: promo.value }, promoStatus);
  });
  codeSave.addEventListener('click', function () {
    put('/staff/admin/staff-access-code', { code: code.value }, codeStatus).then(function (ok) {
      if (!ok) return;
      code.setAttribute('data-configured', code.value.trim() ? 'true' : 'false');
    });
  });
  return refreshWolfhouseStaffPortalFields(wrap);
}

function refreshWolfhouseStaffPortalFields(wrap) {
  var promo = document.getElementById('wh-wetsuit-promo-text');
  var code = document.getElementById('wh-staff-access-code');
  var promoStatus = document.getElementById('wh-wetsuit-promo-status');
  var codeStatus = document.getElementById('wh-staff-access-code-status');
  function read(path) {
    return fetch(path, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    }).then(function (response) {
      if (!response.ok) throw new Error('load_failed');
      return response.json();
    });
  }
  return Promise.all([
    read('/staff/admin/wetsuit-promo').then(function (body) {
      if (!promo || !body || body.success !== true || typeof body.text !== 'string') {
        throw new Error('invalid_promo');
      }
      promo.value = body.text;
      wolfhouseStaffPortalFieldsStatus(promoStatus, '', false, false);
    }).catch(function () {
      wolfhouseStaffPortalFieldsStatus(promoStatus, whStaffFieldsT('lunaStaff.fields.loadFailed', 'Could not load.'), true, false);
    }),
    read('/staff/admin/staff-access-code').then(function (body) {
      if (!code || !body || body.success !== true || typeof body.code !== 'string') {
        throw new Error('invalid_access_code');
      }
      code.value = body.code;
      code.setAttribute('data-configured', body.configured === true ? 'true' : 'false');
      wolfhouseStaffPortalFieldsStatus(codeStatus, '', false, false);
    }).catch(function () {
      wolfhouseStaffPortalFieldsStatus(codeStatus, whStaffFieldsT('lunaStaff.fields.loadFailed', 'Could not load.'), true, false);
    }),
  ]).then(function () { return wrap; });
}

if (typeof window !== 'undefined') {
  window.loadWolfhouseStaffPortalFields = loadWolfhouseStaffPortalFields;
  if (!window.__whStaffPortalFieldsClientBound) {
    window.__whStaffPortalFieldsClientBound = true;
    document.addEventListener('change', function (event) {
      var target = event.target;
      if (!target || target.id !== 'c-client') return;
      loadWolfhouseStaffPortalFields();
    });
  }
}
