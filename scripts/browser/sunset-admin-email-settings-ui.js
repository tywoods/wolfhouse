/* Stage 6 Slice 1 + prepare prerequisite + Phase B reauthorize control (B3b). */
var adminEmailSettingsLoadSeq = 0;
var adminEmailReauthSeq = 0;
var adminEmailReauthAbortController = null;
var adminEmailReauthOrigin = null;

/* Independently owned browser contract for Phase B reauth success validation.
 * Deliberately not imported from route/B1 producers (no self-fulfilling checks). */
var REAUTH_UI_AUTHORITY_ORIGIN = 'https://login.microsoftonline.com';
var REAUTH_UI_AUTHORITY_PATH = '/organizations/oauth2/v2.0/authorize';
var REAUTH_UI_REDIRECT_URI = 'https://sunset-staging.lunafrontdesk.com/staff/email/oauth/microsoft/callback';
var REAUTH_UI_SCOPES = 'openid profile offline_access User.Read Mail.ReadWrite Mail.Send';
var REAUTH_UI_QUERY_KEYS = [
  'client_id', 'response_type', 'redirect_uri', 'response_mode', 'scope',
  'state', 'nonce', 'code_challenge', 'code_challenge_method', 'prompt'
];
var REAUTH_UI_B64URL_32_RE = /^[A-Za-z0-9_-]{43}$/;
var REAUTH_UI_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var REAUTH_UI_MAX_TTL_MS = 15 * 60 * 1000;
var REAUTH_UI_PATH = '/staff/admin/email-settings/oauth/microsoft/reauthorize';

function adminEmailStateKey(state){
  var allowed = ['unavailable','loading','disconnected','registered_not_connected','connected_health','reauth_required','revoked'];
  return allowed.indexOf(String(state || '')) >= 0 ? String(state) : 'error';
}
function isAllowedMicrosoftAuthorizationUrl(raw){
  try {
    var target = new URL(raw);
    return target.origin === 'https://login.microsoftonline.com' && target.pathname === '/organizations/oauth2/v2.0/authorize';
  } catch (_) { return false; }
}

/**
 * Invalidate/abort any pending Phase B reauthorization request.
 * Production function — called by tab/client navigation and render/load paths.
 * Monotonic request token + AbortController when available.
 */
function cancelAdminEmailReauthorization(){
  adminEmailReauthSeq += 1;
  var ac = adminEmailReauthAbortController;
  adminEmailReauthAbortController = null;
  adminEmailReauthOrigin = null;
  if (ac && typeof ac.abort === 'function') {
    try { ac.abort(); } catch (_) { /* ignore */ }
  }
}

/**
 * True only when the originating reauth surface is still live and in-context:
 * exact Sunset client, originating body/section/button connected, Admin Email
 * tab selected, Email panel active/visible.
 */
function isAdminEmailReauthSurfaceLive(origin, mySeq){
  try {
    if (mySeq !== adminEmailReauthSeq) return false;
    if (typeof getClient === 'function' && getClient() !== 'sunset') return false;
    if (!origin || !origin.body || !origin.btn || !origin.section) return false;
    var body = origin.body;
    var btn = origin.btn;
    var section = origin.section;
    // Connected DOM: not detached by re-render / navigation.
    if (typeof body.isConnected === 'boolean' && body.isConnected !== true) return false;
    if (typeof btn.isConnected === 'boolean' && btn.isConnected !== true) return false;
    if (typeof section.isConnected === 'boolean' && section.isConnected !== true) return false;
    if (typeof document !== 'undefined' && document.body) {
      if (typeof document.body.contains === 'function') {
        if (!document.body.contains(body)) return false;
        if (!document.body.contains(btn)) return false;
        if (!document.body.contains(section)) return false;
      }
    }
    // Admin top-level tab must be active.
    var adminBtn = typeof document !== 'undefined' && document.querySelector
      ? document.querySelector('button.tab-btn[data-tab="admin"]')
      : null;
    if (!adminBtn || !adminBtn.classList || !adminBtn.classList.contains('active')) return false;
    // Email sub-tab selected.
    var emailTab = typeof document !== 'undefined' && document.getElementById
      ? document.getElementById('admin-tab-email')
      : null;
    if (!emailTab || emailTab.getAttribute('aria-selected') !== 'true') return false;
    // Email panel active/visible (not hidden).
    var emailPanel = typeof document !== 'undefined' && document.getElementById
      ? document.getElementById('admin-panel-email')
      : null;
    if (!emailPanel) return false;
    if (emailPanel.hasAttribute && emailPanel.hasAttribute('hidden')) return false;
    if (emailPanel.hidden === true) return false;
    // Originating body must still be the live settings body.
    var liveBody = typeof el === 'function' ? el('admin-email-settings-body') : null;
    if (liveBody && liveBody !== body) return false;
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Validate Phase B reauthorize success DTO (exact own-data keys only).
 * Returns validated authorization URL string or null. Never logs URL/token.
 */
function validatePhaseBReauthorizeSuccessDto(dto){
  try {
    if (!dto || typeof dto !== 'object') return null;
    var keys = [];
    for (var k in dto) {
      if (Object.prototype.hasOwnProperty.call(dto, k)) keys.push(k);
    }
    if (keys.length !== 2) return null;
    if (keys[0] !== 'authorization_url' || keys[1] !== 'expires_at') {
      // Order-independent own-key set acceptance (JSON parse order not guaranteed).
      if (keys.indexOf('authorization_url') < 0 || keys.indexOf('expires_at') < 0) return null;
      if (keys.length !== 2) return null;
    }
    var urlRaw = dto.authorization_url;
    var expRaw = dto.expires_at;
    if (typeof urlRaw !== 'string' || typeof expRaw !== 'string') return null;
    if (!expRaw || expRaw.length > 64) return null;
    var expMs = Date.parse(expRaw);
    if (!Number.isFinite(expMs)) return null;
    var now = Date.now();
    if (expMs <= now) return null;
    if (expMs - now > REAUTH_UI_MAX_TTL_MS) return null;
    var parsed = new URL(urlRaw);
    if (parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    if (parsed.port !== '') return null;
    if (parsed.hash !== '') return null;
    if (parsed.origin !== REAUTH_UI_AUTHORITY_ORIGIN) return null;
    if (parsed.pathname !== REAUTH_UI_AUTHORITY_PATH) return null;
    var seen = [];
    parsed.searchParams.forEach(function(_v, key){ seen.push(key); });
    if (seen.length !== REAUTH_UI_QUERY_KEYS.length) return null;
    var i;
    for (i = 0; i < REAUTH_UI_QUERY_KEYS.length; i += 1) {
      if (seen[i] !== REAUTH_UI_QUERY_KEYS[i]) return null;
    }
    for (i = 0; i < REAUTH_UI_QUERY_KEYS.length; i += 1) {
      if (parsed.searchParams.getAll(REAUTH_UI_QUERY_KEYS[i]).length !== 1) return null;
    }
    var clientId = parsed.searchParams.get('client_id');
    if (typeof clientId !== 'string' || !REAUTH_UI_UUID_RE.test(clientId)) return null;
    if (parsed.searchParams.get('response_type') !== 'code') return null;
    if (parsed.searchParams.get('redirect_uri') !== REAUTH_UI_REDIRECT_URI) return null;
    if (parsed.searchParams.get('response_mode') !== 'query') return null;
    if (parsed.searchParams.get('scope') !== REAUTH_UI_SCOPES) return null;
    if (parsed.searchParams.get('code_challenge_method') !== 'S256') return null;
    if (parsed.searchParams.get('prompt') !== 'consent') return null;
    var state = parsed.searchParams.get('state');
    var nonce = parsed.searchParams.get('nonce');
    var challenge = parsed.searchParams.get('code_challenge');
    if (typeof state !== 'string' || !REAUTH_UI_B64URL_32_RE.test(state)) return null;
    if (typeof nonce !== 'string' || !REAUTH_UI_B64URL_32_RE.test(nonce)) return null;
    if (typeof challenge !== 'string' || !REAUTH_UI_B64URL_32_RE.test(challenge)) return null;
    return urlRaw;
  } catch (_) { return null; }
}

/**
 * POST OAuth start with exact ordered body { location_id, endpoint_id }.
 * Validates Microsoft authorization URL then navigates. Never logs URL/token.
 */
function postMicrosoftOAuthStart(locationId, endpointId){
  return fetch('/staff/admin/email-settings/oauth/microsoft/start', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ location_id: locationId, endpoint_id: endpointId })
  }).then(function(r){ return r.ok ? r.json() : Promise.reject(new Error('unavailable')); })
    .then(function(dto){
      if (!dto || typeof dto.authorization_url !== 'string') throw new Error('invalid_response');
      var target = new URL(dto.authorization_url);
      if (!isAllowedMicrosoftAuthorizationUrl(target.toString())) throw new Error('invalid_authority');
      window.location.assign(target.toString());
    });
}

/**
 * POST Phase B reauthorize with exact ordered body { location_id, endpoint_id }.
 * Browser supplies no client/provider/generation/scopes/redirect/authority/mailbox.
 * Optional AbortSignal cancels in-flight request when surface leaves.
 * Validates exact success DTO then returns validated URL (caller navigates).
 */
function postMicrosoftOAuthReauthorize(locationId, endpointId, signal){
  var opts = {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ location_id: locationId, endpoint_id: endpointId })
  };
  if (signal) opts.signal = signal;
  return fetch(REAUTH_UI_PATH, opts).then(function(r){
    if (!r || r.ok !== true) return Promise.reject(new Error('unavailable'));
    return r.json();
  }).then(function(dto){
    var validated = validatePhaseBReauthorizeSuccessDto(dto);
    if (!validated) throw new Error('invalid_response');
    return validated;
  });
}

/**
 * POST prepare with exact ordered body { location_id, public_address }.
 * Returns endpoint_id only (no mailbox echo expected).
 * Exact path: /staff/admin/email-settings/oauth/microsoft/endpoint
 * Prepare creates the disabled endpoint before starting OAuth.
 */
function postMicrosoftEndpointPrepare(locationId, publicAddress){
  return fetch('/staff/admin/email-settings/oauth/microsoft/endpoint', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ location_id: locationId, public_address: publicAddress })
  }).then(function(r){ return r.ok ? r.json() : Promise.reject(new Error('unavailable')); })
    .then(function(dto){
      if (!dto || dto.success !== true || typeof dto.endpoint_id !== 'string') {
        throw new Error('invalid_response');
      }
      return dto.endpoint_id;
    });
}
function setConnectBusy(root, busy){
  if (!root) return;
  var btn = root.querySelector('[data-email-connect]');
  var input = root.querySelector('[data-email-prepare-address]');
  var reauth = root.querySelector('[data-email-reauthorize]');
  if (btn) btn.disabled = busy === true;
  if (input) input.disabled = busy === true;
  if (reauth) reauth.disabled = busy === true;
}
function wireConnectHandlers(body, data){
  var section = body.querySelector('.portal-admin-email-settings');
  if (!section) return;
  var btn = section.querySelector('[data-email-connect]');
  if (!btn) return;
  btn.addEventListener('click', function(){
    var mode = btn.getAttribute('data-email-connect') || '';
    var locationId = btn.getAttribute('data-email-location-id') || '';
    if (!locationId) {
      renderAdminEmailSettingsState('error');
      return;
    }
    setConnectBusy(section, true);
    var chain;
    if (mode === 'prepare') {
      var input = section.querySelector('[data-email-prepare-address]');
      var address = input && typeof input.value === 'string' ? input.value : '';
      if (!address) {
        setConnectBusy(section, false);
        renderAdminEmailSettingsState('error');
        return;
      }
      // Prepare → start exact sequence; never create on page load.
      chain = postMicrosoftEndpointPrepare(locationId, address).then(function(endpointId){
        return postMicrosoftOAuthStart(locationId, endpointId);
      });
    } else if (mode === 'connect') {
      var endpointId = btn.getAttribute('data-email-endpoint-id') || '';
      if (!endpointId) {
        setConnectBusy(section, false);
        renderAdminEmailSettingsState('error');
        return;
      }
      // Existing eligible endpoint: start only (no second prepare).
      chain = postMicrosoftOAuthStart(locationId, endpointId);
    } else {
      setConnectBusy(section, false);
      renderAdminEmailSettingsState('error');
      return;
    }
    chain.catch(function(){
      setConnectBusy(section, false);
      renderAdminEmailSettingsState('error');
    });
  });
}
function wireReauthorizeHandlers(body, data){
  var section = body.querySelector('.portal-admin-email-settings');
  if (!section) return;
  var btn = section.querySelector('[data-email-reauthorize]');
  if (!btn) return;
  btn.addEventListener('click', function(){
    // Second click while pending is ignored (disabled + monotonic seq).
    if (btn.disabled) return;
    var locationId = btn.getAttribute('data-email-location-id') || '';
    var endpointId = btn.getAttribute('data-email-endpoint-id') || '';
    if (!locationId || !endpointId) {
      renderAdminEmailSettingsState('error');
      return;
    }
    if (typeof getClient === 'function' && getClient() !== 'sunset') {
      renderAdminEmailSettingsState('unavailable');
      return;
    }
    // Abort any prior pending reauth, then mint this click's token + AbortController.
    cancelAdminEmailReauthorization();
    var mySeq = ++adminEmailReauthSeq;
    var ac = (typeof AbortController === 'function') ? new AbortController() : null;
    adminEmailReauthAbortController = ac;
    var origin = { body: body, section: section, btn: btn };
    adminEmailReauthOrigin = origin;
    setConnectBusy(section, true);
    postMicrosoftOAuthReauthorize(locationId, endpointId, ac ? ac.signal : undefined)
      .then(function(validatedUrl){
        // Stale / aborted / left Email/Admin/client / re-render: no navigation.
        if (!isAdminEmailReauthSurfaceLive(origin, mySeq)) return;
        // Explicit same-tab navigation from click lifecycle; no opener risk.
        window.location.assign(validatedUrl);
      })
      .catch(function(err){
        // AbortError after leave: quiet — no error state on a different surface.
        var aborted = err && (err.name === 'AbortError' || err.code === 20);
        if (aborted || mySeq !== adminEmailReauthSeq) return;
        if (!isAdminEmailReauthSurfaceLive(origin, mySeq)) return;
        setConnectBusy(section, false);
        renderAdminEmailSettingsState('error');
      });
  });
}
function renderAdminEmailSettingsState(state, data){
  var body = el('admin-email-settings-body');
  if (!body) return;
  // Re-render invalidates any pending reauth (origin body/button will detach).
  cancelAdminEmailReauthorization();
  var key = adminEmailStateKey(state);
  var actions = data && data.actions ? data.actions : null;
  var hasPrepare = !!(actions && actions.prepare === true && data.location_id);
  var hasConnect = !!(actions && actions.connect === true && data.location_id && data.endpoint_id);
  var hasDisconnect = !!(actions && actions.disconnect === true);
  // Prefer server-authoritative per-endpoint fact; fall back to top-level action.
  var hasReauthorize = !!(
    data && data.location_id && data.endpoint_id && (
      data.reauthorize_eligible === true
      || (actions && actions.reauthorize === true)
    )
  );
  // Never show prepare/connect and reauthorize simultaneously for one endpoint.
  if (hasReauthorize && (hasPrepare || hasConnect)) {
    hasPrepare = false;
    hasConnect = false;
  }
  var hasAnyAction = hasPrepare || hasConnect || hasDisconnect || hasReauthorize;
  var html = '<section class="portal-admin-email-settings" data-email-state="' + escHtml(key) + '">' +
    '<h2>' + escHtml(portalT('admin.email.title')) + '</h2>' +
    '<p role="status">' + escHtml(portalT('admin.email.state.' + key)) + '</p>';
  if (data && data.public_address) html += '<p class="portal-admin-email-address">' + escHtml(data.public_address) + '</p>';
  // Prepare controls grouped before capability list; deterministic selectors + a11y label.
  if (hasPrepare) {
    html += '<div class="portal-admin-email-prepare-group" data-email-prepare-group role="group" aria-label="' + escHtml(portalT('admin.email.mailboxLabel')) + '">' +
      '<label class="portal-admin-email-prepare">' +
      '<span>' + escHtml(portalT('admin.email.mailboxLabel')) + '</span>' +
      '<input type="email" autocomplete="off" data-email-prepare-address maxlength="320" />' +
      '</label>' +
      '<button type="button" class="portal-admin-email-action-btn" data-email-connect="prepare" data-email-location-id="' + escHtml(data.location_id) + '">Connect Microsoft email</button>' +
      '</div>';
  } else if (hasConnect) {
    // Existing eligible unverified endpoint — Connect starts OAuth only.
    html += '<div class="portal-admin-email-prepare-group" data-email-prepare-group role="group" aria-label="' + escHtml(portalT('admin.email.mailboxLabel')) + '">' +
      '<button type="button" class="portal-admin-email-action-btn" data-email-connect="connect" data-email-location-id="' + escHtml(data.location_id) + '" data-email-endpoint-id="' + escHtml(data.endpoint_id) + '">Connect Microsoft email</button>' +
      '</div>';
  } else if (hasReauthorize) {
    // Phase B reauthorize — explicit control only when DTO says eligible.
    html += '<div class="portal-admin-email-reauth-group" data-email-reauth-group role="group" aria-label="' + escHtml(portalT('admin.email.reauthorizeLabel')) + '">' +
      '<button type="button" class="portal-admin-email-action-btn" data-email-reauthorize="1" data-email-location-id="' + escHtml(data.location_id) + '" data-email-endpoint-id="' + escHtml(data.endpoint_id) + '">' +
      escHtml(portalT('admin.email.reauthorizeButton')) +
      '</button>' +
      '</div>';
  }
  // Safety note when prepare or connect is available (identity only; capabilities stay off).
  if (hasPrepare || hasConnect) {
    html += '<p class="portal-admin-email-connect-safety" data-email-connect-safety role="note">' +
      escHtml(portalT('admin.email.connectSafetyNote')) + '</p>';
  }
  // Reauthorize safety: permissions upgrade for staff-approved replies; auth itself sends no email.
  if (hasReauthorize) {
    html += '<p class="portal-admin-email-reauth-safety" data-email-reauth-safety role="note">' +
      escHtml(portalT('admin.email.reauthorizeSafetyNote')) + '</p>';
  }
  // Off capability list always preserved.
  html += '<dl><dt>' + escHtml(portalT('admin.email.endpointActive')) + '</dt><dd>' + escHtml(portalT('admin.email.off')) + '</dd>' +
    '<dt>' + escHtml(portalT('admin.email.inbound')) + '</dt><dd>' + escHtml(portalT('admin.email.off')) + '</dd>' +
    '<dt>' + escHtml(portalT('admin.email.outbound')) + '</dt><dd>' + escHtml(portalT('admin.email.off')) + '</dd>' +
    '<dt>' + escHtml(portalT('admin.email.automation')) + '</dt><dd>' + escHtml(portalT('admin.email.off')) + '</dd></dl>';
  // actionsUnavailable ONLY when neither prepare nor connect nor disconnect nor reauthorize is true.
  if (!hasAnyAction) {
    html += '<p data-email-actions-unavailable>' + escHtml(portalT('admin.email.actionsUnavailable')) + '</p>';
  }
  html += '</section>';
  body.innerHTML = html;
  wireConnectHandlers(body, data);
  wireReauthorizeHandlers(body, data);
}
function loadAdminEmailSettings(){
  var body = el('admin-email-settings-body');
  if (!body) return;
  // Panel reload / re-entry: abort any pending reauth before new load.
  cancelAdminEmailReauthorization();
  var seq = ++adminEmailSettingsLoadSeq;
  var client = getClient();
  if (client !== 'sunset') { renderAdminEmailSettingsState('unavailable'); return; }
  body.innerHTML = '<p role="status" data-email-state="loading">' + escHtml(portalT('admin.email.state.loading')) + '</p>';
  fetch('/staff/admin/email-settings?client=sunset', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
    .then(function(r){ return r.ok ? r.json() : Promise.reject(new Error('unavailable')); })
    .then(function(data){
      if (seq !== adminEmailSettingsLoadSeq || getClient() !== 'sunset') return;
      var endpoints = data && Array.isArray(data.endpoints) ? data.endpoints : [];
      var actions = data && data.actions ? data.actions : { prepare: false, connect: false, disconnect: false, reauthorize: false };
      if (!endpoints.length) {
        var locations = data && Array.isArray(data.locations) ? data.locations : [];
        var activeLoc = '';
        for (var i = 0; i < locations.length; i += 1) {
          if (locations[i] && locations[i].active) { activeLoc = locations[i].location_id || ''; break; }
        }
        renderAdminEmailSettingsState('disconnected', {
          actions: actions,
          location_id: activeLoc
        });
      } else {
        var ep = endpoints[0];
        ep.actions = actions;
        renderAdminEmailSettingsState(ep.connection_state, ep);
      }
    })
    .catch(function(){ if (seq === adminEmailSettingsLoadSeq) renderAdminEmailSettingsState('error'); });
}

/* Narrow production exposure: tab/client navigation outside nested scopes + verifiers. */
try {
  if (typeof window !== 'undefined') {
    window.cancelAdminEmailReauthorization = cancelAdminEmailReauthorization;
  }
} catch (_expose) { /* ignore */ }
