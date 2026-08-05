/* Stage 6 Slice 1: inert, read-only Sunset Email Settings panel. */
var adminEmailSettingsLoadSeq = 0;

function adminEmailStateKey(state){
  var allowed = ['unavailable','loading','disconnected','registered_not_connected','connected_health','reauth_required','revoked'];
  return allowed.indexOf(String(state || '')) >= 0 ? String(state) : 'error';
}
function renderAdminEmailSettingsState(state, data){
  var body = el('admin-email-settings-body');
  if (!body) return;
  var key = adminEmailStateKey(state);
  var html = '<section class="portal-admin-email-settings" data-email-state="' + escHtml(key) + '">' +
    '<h2>' + escHtml(portalT('admin.email.title')) + '</h2>' +
    '<p role="status">' + escHtml(portalT('admin.email.state.' + key)) + '</p>';
  if (data && data.public_address) html += '<p class="portal-admin-email-address">' + escHtml(data.public_address) + '</p>';
  html += '<dl><dt>' + escHtml(portalT('admin.email.endpointActive')) + '</dt><dd>' + escHtml(portalT('admin.email.off')) + '</dd>' +
    '<dt>' + escHtml(portalT('admin.email.inbound')) + '</dt><dd>' + escHtml(portalT('admin.email.off')) + '</dd>' +
    '<dt>' + escHtml(portalT('admin.email.outbound')) + '</dt><dd>' + escHtml(portalT('admin.email.off')) + '</dd>' +
    '<dt>' + escHtml(portalT('admin.email.automation')) + '</dt><dd>' + escHtml(portalT('admin.email.off')) + '</dd></dl>' +
    '<p>' + escHtml(portalT('admin.email.actionsUnavailable')) + '</p></section>';
  body.innerHTML = html;
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
      if (!endpoints.length) renderAdminEmailSettingsState('disconnected');
      else renderAdminEmailSettingsState(endpoints[0].connection_state, endpoints[0]);
    })
    .catch(function(){ if (seq === adminEmailSettingsLoadSeq) renderAdminEmailSettingsState('error'); });
}
