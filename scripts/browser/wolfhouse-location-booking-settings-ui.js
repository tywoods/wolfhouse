/* Wolfhouse TEST — Luna Staff location and booking settings cards. UI only. */
/* global document, fetch, getClient, URL */

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
  var location = raw && raw.location;
  var booking = raw && raw.booking_settings;
  var minutes = booking && booking.unpaid_hold_minutes;
  if (!location || typeof location !== 'object' ||
      typeof location.address_text !== 'string' ||
      typeof location.google_maps_url !== 'string' ||
      !booking || typeof booking !== 'object' ||
      !Number.isInteger(minutes) || minutes < 1 ||
      typeof booking.require_each_guest_deposit !== 'boolean') {
    throw new Error('invalid_settings_response');
  }
  var locked = booking.locked === true || raw.locked === true;
  var lockReason = booking.lock_reason || raw.lock_reason || '';
  if (typeof lockReason !== 'string') throw new Error('invalid_settings_response');
  var rawMapUrl = location.google_maps_url;
  if (!isSafeWolfhouseMapUrl(rawMapUrl)) throw new Error('invalid_settings_response');
  var mapUrl = rawMapUrl.trim();
  return {
    location: {
      address_text: location.address_text.trim(),
      google_maps_url: mapUrl
    },
    booking_settings: {
      unpaid_hold_minutes: minutes,
      require_each_guest_deposit: booking.require_each_guest_deposit,
      locked: locked,
      lock_reason: lockReason
    }
  };
}

function isSafeWolfhouseMapUrl(value) {
  var raw = String(value || '');
  if (/[\u0000-\u001F\u007F-\u009F]/.test(raw)) return false;
  var text = raw.trim();
  if (!text) return true;
  try {
    var parsed = new URL(text);
    return parsed.protocol === 'https:' && !!parsed.hostname && !parsed.username && !parsed.password;
  } catch (_error) {
    return false;
  }
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
  refs.note.textContent = locked ? 'Locked because a deposit has already been received.' : '';
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
  });
}

function wolfhouseLocationBookingRead() {
  return fetch('/staff/admin/location-booking-settings', {
    method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' }
  }).then(function (response) {
    if (!response.ok) throw new Error('load_failed');
    return response.json();
  }).then(normalizeWolfhouseLocationBookingSettings);
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
        '<div class="portal-admin-edit-field wh-lbs-wide"><span class="wh-lbs-label">Address</span><div class="wh-lbs-address" id="wh-location-address-text"></div></div>' +
        '<div class="portal-admin-edit-field wh-lbs-wide"><label for="wh-location-map-url">Google Maps link</label><input id="wh-location-map-url" type="url" inputmode="url" spellcheck="false" aria-describedby="wh-map-help"><div class="portal-admin-muted" id="wh-map-help">Clear this field to stop Luna sending a map link.</div></div>' +
        '<div class="wh-lbs-map-action wh-lbs-wide"><a class="btn btn-ghost" id="wh-map-open" target="_blank" rel="noopener noreferrer">Open map preview</a></div>' +
        '<div class="portal-admin-edit-actions"><span class="portal-admin-muted wh-lbs-status" id="wh-location-status" role="status"></span><button type="button" class="btn btn-primary" id="wh-location-save">Save location</button></div>' +
      '</div>' +
    '</section>' +
    '<section class="portal-admin-section" id="wh-booking-settings-card">' +
      '<div class="portal-admin-section-hdr"><div class="portal-admin-section-hdr-title">Booking Settings</div></div>' +
      '<div class="portal-admin-edit-form wh-lbs-form">' +
        '<div class="portal-admin-edit-field"><label for="wh-unpaid-hold-minutes">Hold time before deposit is required (minutes)</label><input id="wh-unpaid-hold-minutes" type="number" min="1" step="1" inputmode="numeric"></div>' +
        '<div><label class="sns-toggle-row wh-lbs-toggle" for="wh-require-each-deposit"><input id="wh-require-each-deposit" type="checkbox"><span class="sns-toggle-label">Require every guest\'s deposit</span></label><p class="portal-admin-muted wh-lbs-help" id="wh-deposit-rule-help"></p></div>' +
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
      '#wh-location-booking-settings .wh-lbs-label{display:block;font-weight:600;margin-bottom:6px}' +
      '#wh-location-booking-settings .wh-lbs-address{min-height:22px}' +
      '#wh-location-booking-settings .wh-lbs-map-action{display:flex;margin-top:-2px}' +
      '#wh-location-booking-settings .wh-lbs-toggle{min-height:28px;align-self:end}' +
      '#wh-location-booking-settings .wh-lbs-help{margin:4px 0 0}' +
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
  } catch (_error) { return Promise.resolve(null); }
  var wrap = ensureWolfhouseLocationBookingCards();
  if (!wrap) return Promise.resolve(null);
  var operationToken = (wrap._wolfhouseOperationToken || 0) + 1;
  wrap._wolfhouseOperationToken = operationToken;
  wrap._wolfhouseLoadGeneration = (wrap._wolfhouseLoadGeneration || 0) + 1;
  if (!wrap._wolfhouseDirty) wrap._wolfhouseDirty = { location: false, booking: false };
  if (!wrap._wolfhouseDraftVersion) wrap._wolfhouseDraftVersion = { location: 0, booking: 0 };

  var refs = {
    addressText: document.getElementById('wh-location-address-text'),
    map: document.getElementById('wh-location-map-url'),
    mapOpen: document.getElementById('wh-map-open'),
    hold: document.getElementById('wh-unpaid-hold-minutes'),
    each: document.getElementById('wh-require-each-deposit'),
    depositHelp: document.getElementById('wh-deposit-rule-help'),
    note: document.getElementById('wh-booking-lock-note'),
    locationStatus: document.getElementById('wh-location-status'),
    bookingStatus: document.getElementById('wh-booking-status'),
    locationSave: document.getElementById('wh-location-save'),
    save: document.getElementById('wh-booking-save')
  };

  function updateMapAction() {
    var value = refs.map.value.trim();
    var safe = value && isSafeWolfhouseMapUrl(value);
    refs.mapOpen.hidden = !safe;
    if (safe) refs.mapOpen.href = value;
    else refs.mapOpen.removeAttribute('href');
  }

  function updateDepositHelp() {
    refs.depositHelp.textContent = refs.each.checked
      ? 'ON — every guest must pay their deposit before the booking is locked.'
      : 'OFF — one guest deposit locks the whole booking.';
  }

  function paint(settings, savedCard) {
    var bookingLocked = settings.booking_settings.locked === true && settings.booking_settings.lock_reason === 'deposit_received';
    wrap._wolfhouseSettings = settings;
    refs.addressText.textContent = settings.location.address_text;
    if (savedCard === 'location' || !wrap._wolfhouseDirty.location) {
      refs.map.value = settings.location.google_maps_url;
      if (savedCard === 'location') wrap._wolfhouseDirty.location = false;
    }
    if (savedCard === 'booking' || !wrap._wolfhouseDirty.booking || bookingLocked) {
      refs.hold.value = String(settings.booking_settings.unpaid_hold_minutes);
      refs.each.checked = settings.booking_settings.require_each_guest_deposit;
      if (savedCard === 'booking' || bookingLocked) wrap._wolfhouseDirty.booking = false;
    }
    updateMapAction();
    updateDepositHelp();
    applyWolfhouseBookingSettingsLock(refs, settings.booking_settings);
    return settings;
  }

  function disableForRead() {
    refs.map.disabled = true;
    refs.locationSave.disabled = true;
    refs.hold.disabled = true;
    refs.each.disabled = true;
    refs.save.disabled = true;
    refs.mapOpen.setAttribute('aria-disabled', 'true');
  }

  function enableFromKnown(settings) {
    refs.map.disabled = false;
    refs.locationSave.disabled = false;
    refs.mapOpen.removeAttribute('aria-disabled');
    applyWolfhouseBookingSettingsLock(refs, settings.booking_settings);
    if (wrap._wolfhouseWriteInFlight) {
      refs.locationSave.disabled = true;
      refs.save.disabled = true;
    }
  }

  function readAndPaint(token, savedCard) {
    var readToken = (wrap._wolfhouseReadToken || 0) + 1;
    wrap._wolfhouseReadToken = readToken;
    disableForRead();
    return wolfhouseLocationBookingRead().then(function (settings) {
      if (token !== wrap._wolfhouseOperationToken || readToken !== wrap._wolfhouseReadToken) return { applied: false, settings: null };
      paint(settings, savedCard);
      wrap._wolfhouseLastAppliedOperationToken = token;
      enableFromKnown(settings);
      return { applied: true, settings: settings };
    }).catch(function (error) {
      if (token !== wrap._wolfhouseOperationToken || readToken !== wrap._wolfhouseReadToken) return { applied: false, settings: null };
      throw error;
    });
  }

  function settleWrite(guard, succeeded) {
    if (wrap._wolfhouseWriteInFlight !== guard) return Promise.resolve(null);
    var savedCard = succeeded && wrap._wolfhouseDraftVersion[guard.card] === guard.draftVersion
      ? guard.card
      : null;

    function ownsPresentation() {
      return guard.loadGeneration === wrap._wolfhouseLoadGeneration &&
        guard.draftVersion === wrap._wolfhouseDraftVersion[guard.card];
    }

    function finish(result) {
      if (wrap._wolfhouseWriteInFlight !== guard) return null;
      wrap._wolfhouseWriteInFlight = null;
      enableFromKnown(result.settings);
      if (!ownsPresentation()) return result;
      if (succeeded) {
        wolfhouseLocationBookingStatus(guard.card === 'location' ? refs.locationStatus : refs.bookingStatus, 'Saved.', false);
      } else {
        wolfhouseLocationBookingStatus(
          guard.card === 'location' ? refs.locationStatus : refs.bookingStatus,
          guard.card === 'location' ? 'Could not save location. The latest server state was reloaded.' : 'Could not save booking settings. The latest server state was reloaded.',
          true
        );
      }
      return result;
    }

    function reconcile() {
      var reconcileToken = (wrap._wolfhouseOperationToken || 0) + 1;
      wrap._wolfhouseOperationToken = reconcileToken;
      return readAndPaint(reconcileToken, savedCard).then(function (result) {
        if (wrap._wolfhouseWriteInFlight !== guard) return null;
        if (result.applied) return finish(result);
        if ((wrap._wolfhouseLastAppliedOperationToken || 0) > reconcileToken && wrap._wolfhouseSettings) {
          return finish({ applied: true, settings: wrap._wolfhouseSettings });
        }
        return reconcile();
      });
    }

    return reconcile().catch(function () {
      if (wrap._wolfhouseWriteInFlight === guard) wrap._wolfhouseWriteInFlight = null;
      disableForRead();
      if (ownsPresentation()) {
        wolfhouseLocationBookingStatus(
          guard.card === 'location' ? refs.locationStatus : refs.bookingStatus,
          'Could not reconcile the save. Reload to retry.',
          true
        );
      }
      return null;
    });
  }

  if (!wrap._wolfhouseSettings) paint(WH_LOCATION_BOOKING_DEFAULTS);
  if (wrap.dataset.wired !== '1') {
    wrap.dataset.wired = '1';
    refs.map.addEventListener('input', function () {
      wrap._wolfhouseDirty.location = true;
      wrap._wolfhouseDraftVersion.location += 1;
      wrap._wolfhouseOperationToken = (wrap._wolfhouseOperationToken || 0) + 1;
      updateMapAction();
    });
    refs.hold.addEventListener('input', function () {
      wrap._wolfhouseDirty.booking = true;
      wrap._wolfhouseDraftVersion.booking += 1;
      wrap._wolfhouseOperationToken = (wrap._wolfhouseOperationToken || 0) + 1;
    });
    refs.each.addEventListener('change', function () {
      wrap._wolfhouseDirty.booking = true;
      wrap._wolfhouseDraftVersion.booking += 1;
      wrap._wolfhouseOperationToken = (wrap._wolfhouseOperationToken || 0) + 1;
      updateDepositHelp();
    });
    refs.locationSave.addEventListener('click', function () {
      if (refs.locationSave.disabled || wrap._wolfhouseWriteInFlight || !wrap._wolfhouseSettings) return;
      if (!isSafeWolfhouseMapUrl(refs.map.value)) {
        wolfhouseLocationBookingStatus(refs.locationStatus, 'Enter a valid https map link, or clear the field.', true);
        return;
      }
      var payload = wolfhouseLocationPayload(wrap._wolfhouseSettings.location.address_text, refs.map.value);
      var saveToken = (wrap._wolfhouseOperationToken || 0) + 1;
      wrap._wolfhouseOperationToken = saveToken;
      var guard = {
        card: 'location',
        saveToken: saveToken,
        loadGeneration: wrap._wolfhouseLoadGeneration,
        draftVersion: wrap._wolfhouseDraftVersion.location
      };
      wrap._wolfhouseWriteInFlight = guard;
      disableForRead();
      wolfhouseLocationBookingStatus(refs.locationStatus, 'Saving…', false);
      wolfhouseLocationBookingPut('/staff/admin/location', payload).then(
        function () { return settleWrite(guard, true); },
        function () { return settleWrite(guard, false); }
      );
    });
    refs.save.addEventListener('click', function () {
      if (refs.save.disabled || wrap._wolfhouseWriteInFlight || !wrap._wolfhouseSettings) return;
      var payload;
      try { payload = wolfhouseBookingSettingsPayload(refs.hold.value, refs.each.checked); }
      catch (_error) {
        wolfhouseLocationBookingStatus(refs.bookingStatus, 'Enter a hold time of at least 1 minute.', true);
        return;
      }
      var saveToken = (wrap._wolfhouseOperationToken || 0) + 1;
      wrap._wolfhouseOperationToken = saveToken;
      var guard = {
        card: 'booking',
        saveToken: saveToken,
        loadGeneration: wrap._wolfhouseLoadGeneration,
        draftVersion: wrap._wolfhouseDraftVersion.booking
      };
      wrap._wolfhouseWriteInFlight = guard;
      disableForRead();
      wolfhouseLocationBookingStatus(refs.bookingStatus, 'Saving…', false);
      wolfhouseLocationBookingPut('/staff/admin/booking-settings', payload).then(
        function () { return settleWrite(guard, true); },
        function () { return settleWrite(guard, false); }
      );
    });
  }

  disableForRead();
  wolfhouseLocationBookingStatus(refs.locationStatus, 'Loading…', false);
  wolfhouseLocationBookingStatus(refs.bookingStatus, 'Loading…', false);
  return readAndPaint(operationToken, null).then(function (settings) {
    if (!settings.applied) return null;
    wolfhouseLocationBookingStatus(refs.locationStatus, '', false);
    wolfhouseLocationBookingStatus(refs.bookingStatus, '', false);
    return settings.settings;
  }).catch(function () {
    disableForRead();
    wolfhouseLocationBookingStatus(refs.locationStatus, 'Could not load settings. Editing remains disabled.', true);
    wolfhouseLocationBookingStatus(refs.bookingStatus, 'Could not load settings. Editing remains disabled.', true);
    return null;
  });
}

if (typeof window !== 'undefined') window.loadWolfhouseLocationBookingSettings = loadWolfhouseLocationBookingSettings;
