/* Stage 6 Slice 1: inert, read-only Sunset Email Settings panel. */
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
function renderAdminEmailSettingsState(state, data){
  var body = el('admin-email-settings-body');
  if (!body) return;
  var key = adminEmailStateKey(state);
  var html = '<section class="portal-admin-email-settings" data-email-state="' + escHtml(key) + '">' +
    '<h2>' + escHtml(portalT('admin.email.title')) + '</h2>' +
    '<p role="status">' + escHtml(portalT('admin.email.state.' + key)) + '</p>';
  if (data && data.public_address) html += '<p class="portal-admin-email-address">' + escHtml(data.public_address) + '</p>';
  if (data && data.actions && data.actions.connect === true && data.location_id) html += '<button type="button" data-email-connect-location="' + escHtml(data.location_id) + '">Connect Microsoft email</button>';
  html += '<dl><dt>' + escHtml(portalT('admin.email.endpointActive')) + '</dt><dd>' + escHtml(portalT('admin.email.off')) + '</dd>' +
    '<dt>' + escHtml(portalT('admin.email.inbound')) + '</dt><dd>' + escHtml(portalT('admin.email.off')) + '</dd>' +
    '<dt>' + escHtml(portalT('admin.email.outbound')) + '</dt><dd>' + escHtml(portalT('admin.email.off')) + '</dd>' +
    '<dt>' + escHtml(portalT('admin.email.automation')) + '</dt><dd>' + escHtml(portalT('admin.email.off')) + '</dd></dl>' +
    '<p>' + escHtml(portalT('admin.email.actionsUnavailable')) + '</p></section>';
  body.innerHTML = html;
  var connect = body.querySelector('[data-email-connect-location]');
  if (connect) connect.addEventListener('click', function(){
    var locationId = connect.getAttribute('data-email-connect-location');
    connect.disabled = true;
    fetch('/staff/admin/email-settings/oauth/microsoft/start', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ location_id: locationId })
    }).then(function(r){ return r.ok ? r.json() : Promise.reject(new Error('unavailable')); })
      .then(function(dto){
        var target = new URL(dto.authorization_url);
        if (!isAllowedMicrosoftAuthorizationUrl(target.toString())) throw new Error('invalid_authority');
        window.location.assign(target.toString());
      }).catch(function(){ connect.disabled = false; renderAdminEmailSettingsState('error'); });
  });
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
      if (!endpoints.length) {
        var locations = data && Array.isArray(data.locations) ? data.locations : [];
        renderAdminEmailSettingsState('disconnected', { actions: data.actions, location_id: locations[0] && locations[0].active ? locations[0].location_id : '' });
      } else {
        endpoints[0].actions = data.actions;
        renderAdminEmailSettingsState(endpoints[0].connection_state, endpoints[0]);
      }
    })
    .catch(function(){ if (seq === adminEmailSettingsLoadSeq) renderAdminEmailSettingsState('error'); });
}
