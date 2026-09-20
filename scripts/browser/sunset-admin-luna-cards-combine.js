/**
 * SUNSET-ADMIN-LUNA-CARDS-COMBINE-001 — one Sunset Admin Luna Staff card:
 * General Notes for Luna, then Guest Conversation alerts, then Automated
 * staff notifications. Style / Personality stay their own cards.
 * Sunset-only. Looks only. No fetch. IDs stay for existing save/load JS.
 */
/* global el, getClient, document */

function salccIsSunset() {
  try {
    var html = (typeof document !== 'undefined') ? document.documentElement : null;
    var attr = (html && html.getAttribute) ? String(html.getAttribute('data-portal-client') || '') : '';
    if (attr && attr !== 'sunset') return false;
    if (typeof getClient === 'function') {
      var client = String(getClient() || '');
      if (client && client !== 'sunset') return false;
      if (client === 'sunset') return true;
    }
    return attr === 'sunset';
  } catch (_e) {
    return false;
  }
}

function salccById(id) {
  if (typeof el === 'function') {
    var fromEl = el(id);
    if (fromEl) return fromEl;
  }
  if (typeof document !== 'undefined' && document.getElementById) return document.getElementById(id);
  return null;
}

function salccEnsureCss() {
  if (typeof document === 'undefined' || !document.getElementById) return;
  if (document.getElementById('sunset-luna-cards-combine-css')) return;
  if (typeof document.createElement !== 'function') return;
  var style = document.createElement('style');
  style.id = 'sunset-luna-cards-combine-css';
  style.textContent = [
    '#cc-luna-notes-alerts-automations{background:var(--surface);border:1px solid var(--border-soft);border-radius:var(--radius);padding:16px 18px;box-shadow:var(--shadow-soft);margin:0}',
    '#cc-luna-notes-alerts-automations>.cc-section{background:transparent;border:none;box-shadow:none;padding:0;margin:0}',
    '#cc-luna-notes-alerts-automations>.cc-section+.cc-section{margin-top:18px;padding-top:18px;border-top:1px solid var(--border-soft)}',
    '[data-theme="dark"] #cc-luna-notes-alerts-automations{background:var(--surface);border-color:var(--border-soft)}'
  ].join('');
  var host = document.head || document.documentElement;
  if (host && typeof host.appendChild === 'function') host.appendChild(style);
}

function salccDemoteCard(node) {
  if (!node || !node.className) return;
  node.className = String(node.className).replace(/\bcard\b/g, '').replace(/\s+/g, ' ').trim();
}

function salccRestoreCard(node) {
  if (!node) return;
  var cls = String(node.className || '');
  if (!/\bcard\b/.test(cls)) node.className = ('card ' + cls).replace(/\s+/g, ' ').trim();
}

function salccVisible(node) {
  if (!node) return false;
  try {
    if (node.style && node.style.display === 'none') return false;
  } catch (_e) { /* ignore */ }
  return true;
}

function salccSyncVisibility(wrap, notes, alerts, autos) {
  if (!wrap || !wrap.style) return;
  wrap.style.display = (salccVisible(notes) || salccVisible(alerts) || salccVisible(autos)) ? '' : 'none';
}

function salccUnwrap(wrap) {
  if (!wrap || !wrap.parentNode || typeof wrap.parentNode.insertBefore !== 'function') return;
  var parent = wrap.parentNode;
  var kids = [salccById('cc-house-notes'), salccById('cc-staff-notification-settings'), salccById('cc-automated-staff-notifications')];
  var i;
  for (i = 0; i < kids.length; i++) {
    if (!kids[i]) continue;
    salccRestoreCard(kids[i]);
    parent.insertBefore(kids[i], wrap);
  }
  if (typeof parent.removeChild === 'function') parent.removeChild(wrap);
}

function paintSunsetAdminLunaCardsCombine() {
  try {
    if (typeof document === 'undefined' || !document.getElementById) return;
    var wrap = salccById('cc-luna-notes-alerts-automations');
    if (!salccIsSunset()) {
      if (wrap) salccUnwrap(wrap);
      return;
    }
    var notes = salccById('cc-house-notes');
    var alerts = salccById('cc-staff-notification-settings');
    var autos = salccById('cc-automated-staff-notifications');
    if (!notes || !alerts || !autos) return;
    if (typeof document.createElement !== 'function') return;
    salccEnsureCss();
    if (!wrap) {
      wrap = document.createElement('section');
      wrap.id = 'cc-luna-notes-alerts-automations';
      wrap.className = 'portal-admin-section';
      wrap.setAttribute('data-sunset-luna-cards-combine', '1');
      var personality = salccById('staff-luna-personality-card');
      var host = (personality && personality.parentNode) || notes.parentNode;
      if (!host || typeof host.insertBefore !== 'function') return;
      if (personality && personality.nextSibling) host.insertBefore(wrap, personality.nextSibling);
      else if (personality) host.appendChild(wrap);
      else host.insertBefore(wrap, notes);
    }
    if (typeof wrap.appendChild !== 'function') return;
    salccDemoteCard(notes);
    salccDemoteCard(alerts);
    salccDemoteCard(autos);
    wrap.appendChild(notes);
    wrap.appendChild(alerts);
    wrap.appendChild(autos);
    salccSyncVisibility(wrap, notes, alerts, autos);
  } catch (_e) { /* never break Admin */ }
}
