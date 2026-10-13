/* Wolfhouse TEST — Luna Staff location and booking settings cards. UI only. */
/* global document, fetch, getClient */

var WH_LOCATION_BOOKING_DEFAULTS = {
  location: {
    address_text: 'C. Mies de La Ran, 41, 39140 Somo, Cantabria',
    google_maps_url: 'https://maps.app.goo.gl/oPRckhqozVBvXxL16'
  },
  booking_settings: {
    unpaid_hold_minutes: 60,
    require_each_guest_deposit: false,
    locked: false,
    lock_reason: ''
  }
};

function normalizeWolfhouseLocationBookingSettings(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};
  var location = raw.location && typeof raw.location === 'object' ? raw.location : {};
  var booking = raw.booking_settings && typeof raw.booking_settings === 'object' ? raw.booking_settings : {};
  var minutes = Number(booking.unpaid_hold_minutes);
  var locked = booking.locked === true || raw.locked === true;
  var lockReason = String(booking.lock_reason || raw.lock_reason || '');
  return {
    location: {
      address_text: String(location.address_text || WH_LOCATION_BOOKING_DEFAULTS.location.address_text).trim(),
      google_maps_url: String(location.google_maps_url || WH_LOCATION_BOOKING_DEFAULTS.location.google_maps_url).trim()
    },
    booking_settings: {
      unpaid_hold_minutes: Number.isInteger(minutes) && minutes > 0 ? minutes : 60,
      require_each_guest_deposit: booking.require_each_guest_deposit === true,
      locked: locked,
      lock_reason: lockReason
    }
  };
}

function wolfhouseLocationPayload(addressText, mapsUrl) {
  return {
    address_text: String(addressText || '').trim(),
    google_maps_url: String(mapsUrl || '').trim()
  };
}

function wolfhouseBookingSettingsPayload(minutes, requireEach) {
  var parsed = Number(minutes);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error('invalid_hold_minutes');
  return {
    unpaid_hold_minutes: parsed,
    require_each_guest_deposit: requireEach === true
  };
}

function applyWolfhouseBookingSettingsLock(refs, settings) {
  var locked = !!(settings && settings.locked === true && settings.lock_reason === 'deposit_received');
  refs.hold.disabled = locked;
  refs.each.disabled = locked;
  if (refs.save) refs.save.disabled = locked;
  refs.note.hidden = !locked;
  refs.note.textContent = locked
    ? 'Locked because a deposit has already been received.'
    : '';
}

function wolfhouseLocationBookingStatus(node, message, isError) {
  if (!node) return;
  node.textContent = message || '';
  node.classList.toggle('is-error', !!isError);
}

function wolfhouseLocationBookingPut(path, body) {
  return fetch(path, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body)
  }).then(function (response) {
    if (!response.ok) throw new Error('save_failed');
    return response.json().catch(function () { return {}; });
  });
}

function ensureWolfhouseLocationBookingCards() {
  var host = document.getElementById('al-wrap');
  var notes = document.getElementById('cc-house-notes');
  if (!host || !notes) return null;
  var existing = document.getElementById('wh-location-booking-settings');
  if (existing) return existing;

  var wrap = document.createElement('div');
  wrap.id = 'wh-location-booking-settings';
  wrap.className = 'wh-location-booking-settings';
  wrap.innerHTML =
    '<section class="portal-admin-section" id="wh-location-settings-card">' +
      '<div class="portal-admin-section-hdr"><div class="portal-admin-section-hdr-title">Location</div></div>' +
      '<div class="portal-admin-edit-form wh-lbs-form">' +
        '<div class="portal-admin-edit-field wh-lbs-wide"><label for="wh-location-address">Address</label><input id="wh-location-address" type="text" autocomplete="street-address"></div>' +
        '<div class="portal-admin-edit-field wh-lbs-wide"><label for="wh-location-map-url">Google Maps link</label><input id="wh-location-map-url" type="url" inputmode="url" spellcheck="false"></div>' +
        '<div class="portal-admin-edit-actions"><span class="portal-admin-muted wh-lbs-status" id="wh-location-status" role="status"></span><button type="button" class="btn btn-primary" id="wh-location-save">Save location</button></div>' +
      '</div>' +
    '</section>' +
    '<section class="portal-admin-section" id="wh-booking-settings-card">' +
      '<div class="portal-admin-section-hdr"><div class="portal-admin-section-hdr-title">Booking Settings</div></div>' +
      '<div class="portal-admin-edit-form wh-lbs-form">' +
        '<div class="portal-admin-edit-field"><label for="wh-unpaid-hold-minutes">Hold time before deposit is required (minutes)</label><input id="wh-unpaid-hold-minutes" type="number" min="1" step="1" inputmode="numeric"></div>' +
        '<label class="sns-toggle-row wh-lbs-toggle" for="wh-require-each-deposit"><input id="wh-require-each-deposit" type="checkbox"><span class="sns-toggle-label">Require every guest\'s deposit</span></label>' +
        '<p class="portal-admin-muted wh-lbs-wide" id="wh-booking-lock-note" hidden></p>' +
        '<div class="portal-admin-edit-actions"><span class="portal-admin-muted wh-lbs-status" id="wh-booking-status" role="status"></span><button type="button" class="btn btn-primary" id="wh-booking-save">Save booking settings</button></div>' +
      '</div>' +
    '</section>';

  if (!document.getElementById('wh-location-booking-settings-css')) {
    var style = document.createElement('style');
    style.id = 'wh-location-booking-settings-css';
    style.textContent =
      '#wh-location-booking-settings{display:grid;gap:14px;width:100%;font-family:var(--font-sans)}' +
      '#wh-location-booking-settings .portal-admin-section-hdr-title{font-weight:700;text-transform:none}' +
      '#wh-location-booking-settings .wh-lbs-form{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:end}' +
      '#wh-location-booking-settings .wh-lbs-wide,#wh-location-booking-settings .portal-admin-edit-actions{grid-column:1/-1}' +
      '#wh-location-booking-settings .portal-admin-edit-field input{width:100%;max-width:none;box-sizing:border-box;min-height:40px}' +
      '#wh-location-booking-settings .wh-lbs-toggle{min-height:44px;align-self:end;padding:0 0 3px}' +
      '#wh-location-booking-settings .portal-admin-edit-actions{justify-content:space-between}' +
      '#wh-location-booking-settings .wh-lbs-status.is-error{color:var(--danger,#a33)}' +
      '@media(max-width:640px){#wh-location-booking-settings .wh-lbs-form{grid-template-columns:1fr}#wh-location-booking-settings .portal-admin-edit-field,#wh-location-booking-settings .wh-lbs-toggle{grid-column:1}}';
    (document.head || document.documentElement).appendChild(style);
  }

  host.insertBefore(wrap, notes.nextSibling);
  return wrap;
}

function loadWolfhouseLocationBookingSettings() {
  try {
    if (typeof getClient === 'function' && getClient() !== 'wolfhouse-somo') return Promise.resolve(null);
  } catch (_e) { return Promise.resolve(null); }
  var wrap = ensureWolfhouseLocationBookingCards();
  if (!wrap) return Promise.resolve(null);

  var refs = {
    address: document.getElementById('wh-location-address'),
    map: document.getElementById('wh-location-map-url'),
    hold: document.getElementById('wh-unpaid-hold-minutes'),
    each: document.getElementById('wh-require-each-deposit'),
    note: document.getElementById('wh-booking-lock-note'),
    locationStatus: document.getElementById('wh-location-status'),
    bookingStatus: document.getElementById('wh-booking-status'),
    locationSave: document.getElementById('wh-location-save'),
    save: document.getElementById('wh-booking-save')
  };

  function paint(data) {
    var settings = normalizeWolfhouseLocationBookingSettings(data);
    refs.address.value = settings.location.address_text;
    refs.map.value = settings.location.google_maps_url;
    refs.hold.value = String(settings.booking_settings.unpaid_hold_minutes);
    refs.each.checked = settings.booking_settings.require_each_guest_deposit;
    applyWolfhouseBookingSettingsLock(refs, settings.booking_settings);
    return settings;
  }

  paint(WH_LOCATION_BOOKING_DEFAULTS);
  if (wrap.dataset.wired !== '1') {
    wrap.dataset.wired = '1';
    refs.locationSave.addEventListener('click', function () {
      var payload = wolfhouseLocationPayload(refs.address.value, refs.map.value);
      if (!payload.address_text || !/^https:\/\//i.test(payload.google_maps_url)) {
        wolfhouseLocationBookingStatus(refs.locationStatus, 'Enter an address and an https map link.', true);
        return;
      }
      refs.locationSave.disabled = true;
      wolfhouseLocationBookingStatus(refs.locationStatus, 'Saving…', false);
      wolfhouseLocationBookingPut('/staff/admin/location', payload)
        .then(function () { wolfhouseLocationBookingStatus(refs.locationStatus, 'Saved.', false); })
        .catch(function () { wolfhouseLocationBookingStatus(refs.locationStatus, 'Could not save location.', true); })
        .finally(function () { refs.locationSave.disabled = false; });
    });
    refs.save.addEventListener('click', function () {
      var payload;
      try { payload = wolfhouseBookingSettingsPayload(refs.hold.value, refs.each.checked); }
      catch (_error) {
        wolfhouseLocationBookingStatus(refs.bookingStatus, 'Enter a hold time of at least 1 minute.', true);
        return;
      }
      refs.save.disabled = true;
      wolfhouseLocationBookingStatus(refs.bookingStatus, 'Saving…', false);
      wolfhouseLocationBookingPut('/staff/admin/booking-settings', payload)
        .then(function (saved) {
          var normalized = normalizeWolfhouseLocationBookingSettings(saved);
          applyWolfhouseBookingSettingsLock(refs, normalized.booking_settings);
          wolfhouseLocationBookingStatus(refs.bookingStatus, 'Saved.', false);
        })
        .catch(function () { wolfhouseLocationBookingStatus(refs.bookingStatus, 'Could not save booking settings.', true); })
        .finally(function () { if (!refs.hold.disabled) refs.save.disabled = false; });
    });
  }

  wolfhouseLocationBookingStatus(refs.locationStatus, 'Loading…', false);
  wolfhouseLocationBookingStatus(refs.bookingStatus, 'Loading…', false);
  return fetch('/staff/admin/location-booking-settings', {
    method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' }
  }).then(function (response) {
    if (!response.ok) throw new Error('load_failed');
    return response.json();
  }).then(function (data) {
    var settings = paint(data);
    wolfhouseLocationBookingStatus(refs.locationStatus, '', false);
    wolfhouseLocationBookingStatus(refs.bookingStatus, '', false);
    return settings;
  }).catch(function () {
    wolfhouseLocationBookingStatus(refs.locationStatus, 'Using TEST defaults until settings are available.', true);
    wolfhouseLocationBookingStatus(refs.bookingStatus, 'Using defaults until settings are available.', true);
    return null;
  });
}

if (typeof window !== 'undefined') {
  window.loadWolfhouseLocationBookingSettings = loadWolfhouseLocationBookingSettings;
}
