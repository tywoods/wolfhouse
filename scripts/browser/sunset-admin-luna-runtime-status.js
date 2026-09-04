/**
 * SUNSET-LUNA-ACA-UI-001 — read-only Guest WhatsApp runtime status on sunset Admin.
 * Guest WhatsApp is still Hermes. The new Luna ACA runtime is additive / not live.
 * Looks only. No extra On/Off, no WhatsApp send.
 */
/* global el, portalT, portalLang, getStaffLocale, getClient, escHtml, document */

function slrsEsc(s) {
  if (typeof escHtml === 'function') return escHtml(s);
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function slrsT(key, en, es) {
  var raw = '';
  try { raw = String((typeof portalT === 'function' && portalT(key)) || ''); } catch (_e) { raw = ''; }
  var lang = '';
  try {
    lang = String((typeof portalLang === 'string' && portalLang) || '');
    if (!lang && typeof getStaffLocale === 'function') lang = String(getStaffLocale() || '');
  } catch (_e2) { lang = ''; }
  var isEs = lang.toLowerCase().indexOf('es') === 0;
  if (raw && raw !== key && raw.indexOf('lunaStaff.runtime.') !== 0) {
    if (isEs && raw === en) return es;
    if (!isEs && raw === es) return en;
    return raw;
  }
  return isEs ? es : en;
}

function slrsIsSunset() {
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

function slrsEnsureCss() {
  if (typeof document === 'undefined' || !document.getElementById) return;
  if (document.getElementById('sunset-luna-runtime-status-css')) return;
  if (typeof document.createElement !== 'function') return;
  var style = document.createElement('style');
  style.id = 'sunset-luna-runtime-status-css';
  style.textContent = [
    '#sunset-luna-runtime-status{background:var(--surface);border:1px solid var(--border-soft);border-radius:var(--radius);padding:16px 18px;box-shadow:var(--shadow-soft);margin:0}',
    '#sunset-luna-runtime-status .portal-admin-section-hdr{margin-bottom:8px}',
    '#sunset-luna-runtime-status .slrs-note{margin:0;font-size:13px;line-height:1.45;color:var(--text-2)}',
    '[data-theme="dark"] #sunset-luna-runtime-status{background:var(--surface);border-color:var(--border-soft)}'
  ].join('');
  var host = document.head || document.documentElement;
  if (host && typeof host.appendChild === 'function') host.appendChild(style);
}

function slrsCardHtml() {
  var title = slrsT('lunaStaff.runtime.title', 'Guest WhatsApp', 'WhatsApp de huéspedes');
  var pill = slrsT('lunaStaff.runtime.hermesPill', 'Live on Hermes', 'Activo en Hermes');
  var note = slrsT(
    'lunaStaff.runtime.note',
    'The new Luna ACA runtime is additive and not live for guests.',
    'El nuevo runtime ACA de Luna es aditivo y no está activo para huéspedes.'
  );
  return (
    '<section class="portal-admin-section" id="sunset-luna-runtime-status" data-sunset-luna-runtime="1" aria-label="' + slrsEsc(title) + '">'
    + '<div class="portal-admin-section-hdr">'
    + '<span>' + slrsEsc(title) + '</span>'
    + '<span class="pill pill-green">' + slrsEsc(pill) + '</span>'
    + '</div>'
    + '<p class="slrs-note">' + slrsEsc(note) + '</p>'
    + '</section>'
  );
}

function slrsFindWrap() {
  if (typeof el === 'function') {
    var fromEl = el('al-wrap');
    if (fromEl) return fromEl;
  }
  if (typeof document !== 'undefined' && document.getElementById) return document.getElementById('al-wrap');
  return null;
}

function slrsFindCard() {
  if (typeof document !== 'undefined' && document.getElementById) {
    return document.getElementById('sunset-luna-runtime-status');
  }
  return null;
}

function paintSunsetLunaRuntimeStatus() {
  try {
    var existing = slrsFindCard();
    if (existing && existing.parentNode && typeof existing.parentNode.removeChild === 'function') {
      existing.parentNode.removeChild(existing);
    }
    return;
  } catch (_e) { /* never break Admin */ }
}
