/**
 * ADMIN-LUNA-STAFF-CARDS-REGROUP-001 — Luna Staff Admin 3-card layout
 * (Sunset + Wolfhouse):
 *   1. General Notes for Luna — own card, first
 *   2. One card: Staff & Owner Numbers → Guest Conversation Alerts →
 *      Automated Staff Notifications
 *   3. One card: Style (Light/Dark) + Luna Personality
 * Looks only. No fetch. IDs stay for existing save/load JS.
 * Supersedes SUNSET-ADMIN-LUNA-CARDS-COMBINE-001 (notes+alerts+autos).
 */
/* global el, getClient, document */

function salccIsTargetPortal() {
  try {
    var html = (typeof document !== 'undefined') ? document.documentElement : null;
    var attr = (html && html.getAttribute) ? String(html.getAttribute('data-portal-client') || '') : '';
    var client = '';
    if (typeof getClient === 'function') client = String(getClient() || '');
    if (client === 'sunset' || client === 'wolfhouse-somo') return true;
    if (attr === 'sunset' || attr === 'wolfhouse' || attr === 'wolfhouse-somo') return true;
    return false;
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
  if (document.getElementById('admin-luna-staff-cards-regroup-css')) return;
  if (typeof document.createElement !== 'function') return;
  var style = document.createElement('style');
  style.id = 'admin-luna-staff-cards-regroup-css';
  style.textContent = [
    '#cc-luna-numbers-alerts-automations,#cc-luna-style-personality{background:var(--surface);border:1px solid var(--border-soft);border-radius:var(--radius);padding:16px 18px;box-shadow:var(--shadow-soft);margin:0;width:100%;max-width:100%;box-sizing:border-box}',
    '#tab-admin #al-wrap #cc-luna-numbers-alerts-automations > .cc-section,#tab-admin #al-wrap #cc-luna-numbers-alerts-automations > .card{background:transparent;border:none;box-shadow:none;padding:0;margin:0}',
    '#tab-admin #al-wrap #cc-luna-numbers-alerts-automations > .cc-section + .cc-section,#tab-admin #al-wrap #cc-luna-numbers-alerts-automations > .card + .card{margin-top:18px;padding-top:18px;border-top:1px solid var(--border-soft)}',
    '#tab-admin #al-wrap #cc-luna-style-personality > .staff-style-card{background:transparent;border:none;box-shadow:none;padding:0;margin:0}',
    '#tab-admin #al-wrap #cc-luna-style-personality > .staff-style-card + .staff-style-card{margin-top:18px;padding-top:18px;border-top:1px solid var(--border-soft)}',
    '[data-theme="dark"] #cc-luna-numbers-alerts-automations,[data-theme="dark"] #cc-luna-style-personality{background:var(--surface);border-color:var(--border-soft)}'
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

function salccSyncVisibility(wrap, kids) {
  if (!wrap || !wrap.style) return;
  var i;
  var any = false;
  for (i = 0; i < kids.length; i++) {
    if (salccVisible(kids[i])) { any = true; break; }
  }
  wrap.style.display = any ? '' : 'none';
}

function salccUnwrapLegacyNotesCombine() {
  var legacy = salccById('cc-luna-notes-alerts-automations');
  if (!legacy || !legacy.parentNode || typeof legacy.parentNode.insertBefore !== 'function') return;
  var parent = legacy.parentNode;
  var kids = [
    salccById('cc-house-notes'),
    salccById('cc-staff-notification-settings'),
    salccById('cc-automated-staff-notifications'),
  ];
  var i;
  for (i = 0; i < kids.length; i++) {
    if (!kids[i]) continue;
    salccRestoreCard(kids[i]);
    parent.insertBefore(kids[i], legacy);
  }
  if (typeof parent.removeChild === 'function') parent.removeChild(legacy);
}

function salccUnwrap(wrap, childIds, restoreCards) {
  if (!wrap || !wrap.parentNode || typeof wrap.parentNode.insertBefore !== 'function') return;
  var parent = wrap.parentNode;
  var i;
  for (i = 0; i < childIds.length; i++) {
    var kid = salccById(childIds[i]);
    if (!kid) continue;
    if (restoreCards) salccRestoreCard(kid);
    parent.insertBefore(kid, wrap);
  }
  if (typeof parent.removeChild === 'function') parent.removeChild(wrap);
}

function salccEnsureWrap(id, marker) {
  var wrap = salccById(id);
  if (wrap) return wrap;
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  wrap = document.createElement('section');
  wrap.id = id;
  wrap.className = 'portal-admin-section';
  wrap.setAttribute(marker, '1');
  return wrap;
}

function paintAdminLunaStaffCardsRegroup() {
  try {
    if (typeof document === 'undefined' || !document.getElementById) return;
    var numbersWrap = salccById('cc-luna-numbers-alerts-automations');
    var styleWrap = salccById('cc-luna-style-personality');
    if (!salccIsTargetPortal()) {
      salccUnwrapLegacyNotesCombine();
      if (numbersWrap) {
        salccUnwrap(numbersWrap, [
          'cc-staff-whatsapp-numbers',
          'cc-staff-notification-settings',
          'cc-automated-staff-notifications',
        ], true);
      }
      if (styleWrap) {
        salccUnwrap(styleWrap, ['staff-style-card', 'staff-luna-personality-card'], false);
      }
      return;
    }

    salccUnwrapLegacyNotesCombine();
    salccEnsureCss();

    var host = salccById('al-wrap');
    var notes = salccById('cc-house-notes');
    var numbers = salccById('cc-staff-whatsapp-numbers');
    var alerts = salccById('cc-staff-notification-settings');
    var autos = salccById('cc-automated-staff-notifications');
    var styleCard = salccById('staff-style-card');
    var personality = salccById('staff-luna-personality-card');
    if (!host || !notes || !numbers || !alerts || !autos || !styleCard || !personality) return;
    if (typeof host.insertBefore !== 'function' || typeof host.appendChild !== 'function') return;

    numbersWrap = salccEnsureWrap('cc-luna-numbers-alerts-automations', 'data-admin-luna-numbers-combine');
    styleWrap = salccEnsureWrap('cc-luna-style-personality', 'data-admin-luna-style-combine');
    if (!numbersWrap || !styleWrap) return;

    salccRestoreCard(notes);
    salccDemoteCard(numbers);
    salccDemoteCard(alerts);
    salccDemoteCard(autos);

    if (typeof numbersWrap.appendChild === 'function') {
      numbersWrap.appendChild(numbers);
      numbersWrap.appendChild(alerts);
      numbersWrap.appendChild(autos);
    }
    if (typeof styleWrap.appendChild === 'function') {
      styleWrap.appendChild(styleCard);
      styleWrap.appendChild(personality);
    }

    salccSyncVisibility(numbersWrap, [numbers, alerts, autos]);
    salccSyncVisibility(styleWrap, [styleCard, personality]);

    // Top → bottom: Notes, Numbers+Alerts+Autos, Style+Personality.
    host.insertBefore(notes, host.firstChild);
    host.insertBefore(numbersWrap, notes.nextSibling);
    host.insertBefore(styleWrap, numbersWrap.nextSibling);
  } catch (_e) { /* never break Admin */ }
}

/** @deprecated alias — keep Sunset Admin call sites working */
function paintSunsetAdminLunaCardsCombine() {
  paintAdminLunaStaffCardsRegroup();
}
