/* Stage 6 Slice 1 + prepare prerequisite: Sunset Email Settings panel. */
var adminEmailSettingsLoadSeq = 0;

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
 * POST prepare with exact ordered body { location_id, public_address }.
 * Returns endpoint_id only (no mailbox echo expected).
 */
function postMicrosoftEndpointPrepare(locationId, publicAddress){
  return fetch('/staff/admin/email-settings/oauth/microsoft/prepare', {
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
  if (btn) btn.disabled = busy === true;
  if (input) input.disabled = busy === true;
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
function renderAdminEmailSettingsState(state, data){
  var body = el('admin-email-settings-body');
  if (!body) return;
  var key = adminEmailStateKey(state);
  var html = '<section class="portal-admin-email-settings" data-email-state="' + escHtml(key) + '">' +
    '<h2>' + escHtml(portalT('admin.email.title')) + '</h2>' +
    '<p role="status">' + escHtml(portalT('admin.email.state.' + key)) + '</p>';
  if (data && data.public_address) html += '<p class="portal-admin-email-address">' + escHtml(data.public_address) + '</p>';
  // Prepare path: no endpoint yet — compact email input + Connect.
  if (data && data.actions && data.actions.prepare === true && data.location_id) {
    html += '<label class="portal-admin-email-prepare">' +
      '<span>' + escHtml(portalT('admin.email.mailboxLabel')) + '</span>' +
      '<input type="email" autocomplete="off" data-email-prepare-address maxlength="320" />' +
      '</label>' +
      '<button type="button" data-email-connect="prepare" data-email-location-id="' + escHtml(data.location_id) + '">Connect Microsoft email</button>';
  } else if (data && data.actions && data.actions.connect === true && data.location_id && data.endpoint_id) {
    // Existing eligible unverified endpoint — Connect starts OAuth only.
    html += '<button type="button" data-email-connect="connect" data-email-location-id="' + escHtml(data.location_id) + '" data-email-endpoint-id="' + escHtml(data.endpoint_id) + '">Connect Microsoft email</button>';
  }
  html += '<dl><dt>' + escHtml(portalT('admin.email.endpointActive')) + '</dt><dd>' + escHtml(portalT('admin.email.off')) + '</dd>' +
    '<dt>' + escHtml(portalT('admin.email.inbound')) + '</dt><dd>' + escHtml(portalT('admin.email.off')) + '</dd>' +
    '<dt>' + escHtml(portalT('admin.email.outbound')) + '</dt><dd>' + escHtml(portalT('admin.email.off')) + '</dd>' +
    '<dt>' + escHtml(portalT('admin.email.automation')) + '</dt><dd>' + escHtml(portalT('admin.email.off')) + '</dd></dl>' +
    '<p>' + escHtml(portalT('admin.email.actionsUnavailable')) + '</p></section>';
  body.innerHTML = html;
  wireConnectHandlers(body, data);
}
function loadAdminEmailSettings(){
  var body = el('admin-email-settings-body');
  if (!body) return;
  var seq = ++adminEmailSettingsLoadSeq;
  var client = getClient();
  if (client !== 'sunset') { renderAdminEmailSettingsState('unavailable'); return; }
  body.innerHTML = '<p role="status" data-email-state="loading">' + escHtml(portalT('admin.email.state.loading')) + '</p>';
  fetch('/staff/admin/email-settings?client=sunset', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
    .then(function(r){ return r.ok ? r.json() : Promise.reject(new Error('unavailable')); })
    .then(function(data){
      if (seq !== adminEmailSettingsLoadSeq || getClient() !== 'sunset') return;
      var endpoints = data && Array.isArray(data.endpoints) ? data.endpoints : [];
      var actions = data && data.actions ? data.actions : { prepare: false, connect: false, disconnect: false };
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
