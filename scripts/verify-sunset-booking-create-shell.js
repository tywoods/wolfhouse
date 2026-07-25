'use strict';

/**
 * verify:sunset-booking-create-shell
 *
 * Project Kaya Slice 1 — offline behavioral checks for the create-booking
 * drawer shell/hierarchy. Static source only — no Staff API, DB, or network.
 *
 * Run: node scripts/verify-sunset-booking-create-shell.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const STAFF_API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const PORTAL_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-portal-module.js');

let pass = 0;
let fail = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    fail += 1;
  }
}

function extractCreateModalHtml(src) {
  const start = src.indexOf('id="ps-create-modal"');
  if (start < 0) return '';
  const open = src.lastIndexOf('<div', start);
  if (open < 0) return '';
  const end = src.indexOf('id="ps-drawer-backdrop"', open);
  if (end < 0) return src.slice(open, open + 12000);
  const close = src.lastIndexOf('</div>', end);
  return src.slice(open, close > open ? close + 6 : end);
}

function extractCssBlock(src, selectorPrefix) {
  let from = 0;
  while (from < src.length) {
    const idx = src.indexOf(selectorPrefix, from);
    if (idx < 0) return '';
    const lineStart = src.lastIndexOf('\n', idx - 1) + 1;
    const beforeSel = src.slice(lineStart, idx).trim();
    if (!beforeSel || beforeSel.endsWith('}') || beforeSel.endsWith(';')) {
      const brace = src.indexOf('{', idx);
      if (brace < 0) return '';
      let depth = 0;
      for (let i = brace; i < src.length; i += 1) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') {
          depth -= 1;
          if (depth === 0) return src.slice(idx, i + 1);
        }
      }
      return '';
    }
    from = idx + selectorPrefix.length;
  }
  return '';
}

function idOrder(html, id) {
  return html.indexOf('id="' + id + '"');
}

console.log('\nverify:sunset-booking-create-shell — Kaya Slice 1 create drawer shell\n');

const apiSrc = fs.readFileSync(STAFF_API, 'utf8');
const portalSrc = fs.existsSync(PORTAL_MODULE) ? fs.readFileSync(PORTAL_MODULE, 'utf8') : '';
const modalHtml = extractCreateModalHtml(apiSrc);

console.log('[1] Modal shell extraction');
assert('create modal markup present', modalHtml.includes('id="ps-create-modal"') && modalHtml.includes('id="ps-create-title"'));
assert('drawer is role=dialog', /role="dialog"/.test(modalHtml));
assert('dialog labelled by title', /aria-labelledby="ps-create-title"/.test(modalHtml));

console.log('\n[2] Sticky chrome — header / body / footer');
assert('sticky/create header present', /portal-schedule-create-header/.test(modalHtml));
assert('scrollable body wrapper present', /portal-schedule-create-body/.test(modalHtml));
assert('sticky footer present', /portal-schedule-create-footer/.test(modalHtml));
assert('human title Create booking',
  /id="ps-create-title"[^>]*>\s*Create booking\s*</.test(modalHtml)
  || /id="ps-create-title"[^>]*data-i18n="schedule\.create\.title"/.test(modalHtml));
assert('accessible X close control', /id="ps-create-close"/.test(modalHtml) && /aria-label=/.test(modalHtml));
assert('X close uses existing safe close path',
  /\[\s*['"]ps-create-close['"]\s*,\s*closeScheduleCreateModal\s*\]/.test(apiSrc));

console.log('\n[3] School context as compact chip; no staging jargon');
assert('school context id preserved', /id="ps-create-school-context"/.test(modalHtml));
assert('school label id preserved', /id="ps-create-school-label"/.test(modalHtml));
assert('school context rendered as chip/context label',
  /portal-schedule-create-school-chip|create-context-chip|create-school-chip/.test(modalHtml + apiSrc));
assert('no internal staging subtitle element', !/portal-schedule-create-sub/.test(modalHtml));
assert('no "staging booking in the database" copy in drawer', !/staging booking in the database/i.test(modalHtml));
assert('no staff-visible schedule.create.sub in drawer markup', !/data-i18n="schedule\.create\.sub"/.test(modalHtml));

console.log('\n[4] Section hierarchy in story order: Guest → What → When → Payment & notes');
const sectionOrder = ['guest', 'what', 'when', 'payment'];
const sectionIdx = sectionOrder.map((s) => {
  const m = new RegExp('data-create-section="' + s + '"').exec(modalHtml);
  return m ? m.index : -1;
});
sectionOrder.forEach((s, i) => assert('section wrapper: ' + s, sectionIdx[i] >= 0));
assert('section order Guest before What', sectionIdx[0] >= 0 && sectionIdx[1] > sectionIdx[0]);
assert('section order What before When', sectionIdx[1] >= 0 && sectionIdx[2] > sectionIdx[1]);
assert('section order When before Payment', sectionIdx[2] >= 0 && sectionIdx[3] > sectionIdx[2]);

const guestPos = idOrder(modalHtml, 'ps-create-guest');
const phonePos = idOrder(modalHtml, 'ps-create-phone');
const coursePos = idOrder(modalHtml, 'ps-create-comp-course');
const privatePos = idOrder(modalHtml, 'ps-create-comp-private-lesson');
const rentalsPos = idOrder(modalHtml, 'ps-create-rentals');
const fulldayPos = idOrder(modalHtml, 'ps-create-addon-fullday-field');
const privateFieldsPos = idOrder(modalHtml, 'ps-create-private-lesson-fields');
const courseFieldsPos = idOrder(modalHtml, 'ps-create-course-fields');
const dateFromPos = idOrder(modalHtml, 'ps-create-date-from');
const dateToPos = idOrder(modalHtml, 'ps-create-date-to');
const paymentPos = idOrder(modalHtml, 'ps-create-payment');
const notesPos = idOrder(modalHtml, 'ps-create-notes');
const quotePos = idOrder(modalHtml, 'ps-create-quote-preview');
const cancelPos = idOrder(modalHtml, 'ps-create-cancel');
const submitPos = idOrder(modalHtml, 'ps-create-submit');

assert('Guest controls before What controls', guestPos >= 0 && phonePos > guestPos && coursePos > phonePos);
assert('What: course before private before rentals', coursePos >= 0 && privatePos > coursePos && rentalsPos > privatePos);
assert('What: rentals before fullday before private fields', rentalsPos >= 0 && fulldayPos > rentalsPos && privateFieldsPos > fulldayPos);
assert('What: private fields before course fields', privateFieldsPos >= 0 && courseFieldsPos > privateFieldsPos);
assert('When: date-from/to after What', dateFromPos > courseFieldsPos && dateToPos > dateFromPos);
assert('Payment & notes after When', paymentPos > dateToPos && notesPos > paymentPos);
assert('quote preview in footer chrome (after notes)', quotePos > notesPos);
assert('footer actions after quote', cancelPos > quotePos && submitPos > quotePos);

console.log('\n[5] Sticky footer slots + action order');
assert('summary slot present (neutral placeholder)',
  /id="ps-create-summary"/.test(modalHtml) && /portal-schedule-create-summary/.test(modalHtml + apiSrc));
assert('summary is placeholder only (no dynamic wiring yet)',
  !/scheduleRenderCreateSummary|updateCreateSummary|ps-create-summary\.textContent\s*=/.test(apiSrc));
assert('quote total uses existing id ps-create-quote-preview', /id="ps-create-quote-preview"/.test(modalHtml));
assert('secondary Cancel present', /id="ps-create-cancel"/.test(modalHtml));
assert('primary Create booking present', /id="ps-create-submit"/.test(modalHtml));
assert('Cancel before Create in footer', cancelPos >= 0 && submitPos > cancelPos);

console.log('\n[6] ID uniqueness + full preserved control set');
const requiredIds = [
  'ps-create-modal', 'ps-create-backdrop', 'ps-create-title',
  'ps-create-school-context', 'ps-create-school-label', 'ps-create-msg',
  'ps-create-guest', 'ps-create-phone',
  'ps-create-comp-course', 'ps-create-comp-private-lesson', 'ps-create-rentals',
  'ps-create-addon-fullday-field', 'ps-create-comp-fullday', 'ps-create-fullday-card',
  'ps-create-fullday-price-hint', 'ps-create-fullday-rows', 'ps-create-fullday-summary',
  'ps-create-private-lesson-fields', 'ps-create-private-lesson-qty', 'ps-create-private-lesson-surfers',
  'ps-create-private-lesson-sessions', 'ps-create-add-session',
  'ps-create-course-fields', 'ps-create-course-select', 'ps-create-course-tier-wrap',
  'ps-create-course-tier', 'ps-create-course-qty-wrap', 'ps-create-course-qty',
  'ps-create-date-range', 'ps-create-date-from', 'ps-create-date-to',
  'ps-create-payment', 'ps-create-notes', 'ps-create-quote-preview',
  'ps-create-submit', 'ps-create-cancel',
];
const idCounts = {};
const idRe = /\bid="(ps-create-[^"]+)"/g;
let m;
while ((m = idRe.exec(modalHtml))) idCounts[m[1]] = (idCounts[m[1]] || 0) + 1;
const dupes = Object.keys(idCounts).filter((k) => idCounts[k] > 1);
assert('no duplicate ps-create-* ids in modal', dupes.length === 0, dupes.join(', '));
const missing = requiredIds.filter((id) => idCounts[id] !== 1);
assert('all required ps-create-* ids present once', missing.length === 0, missing.join(', '));

console.log('\n[7] Private-session / date conditional markers preserved');
assert('private lesson fields wrapper preserved', /id="ps-create-private-lesson-fields"/.test(modalHtml));
assert('date-range wrapper preserved', /id="ps-create-date-range"/.test(modalHtml));
assert('conditional display logic untouched',
  apiSrc.includes("el('ps-create-private-lesson-fields')")
  && apiSrc.includes("el('ps-create-date-range')")
  && apiSrc.includes('scheduleOnCreateComponentChange'));

console.log('\n[8] CSS — flex shell, mobile full-bleed, safe-area, thumb footer');
const drawerCss = extractCssBlock(apiSrc, '.portal-schedule-create-drawer{');
const headerCss = extractCssBlock(apiSrc, '.portal-schedule-create-header{');
const bodyCss = extractCssBlock(apiSrc, '.portal-schedule-create-body{');
const footerCss = extractCssBlock(apiSrc, '.portal-schedule-create-footer{');
const shellCssBlob = [drawerCss, headerCss, bodyCss, footerCss].join('\n');
assert('drawer uses column flex shell',
  /display:\s*flex/.test(shellCssBlob) && /flex-direction:\s*column/.test(shellCssBlob));
assert('drawer does not scroll whole panel (body scrolls)',
  /\.portal-schedule-create-drawer\{[^}]*overflow:\s*hidden/.test(apiSrc) || /overflow:\s*hidden/.test(drawerCss));
assert('body is scroll container',
  /overflow-y:\s*auto/.test(bodyCss) && /-webkit-overflow-scrolling:\s*touch/.test(bodyCss));
assert('header is non-scrolling chrome', /flex:\s*0\s+0\s+auto|flex-shrink:\s*0|position:\s*sticky/.test(headerCss));
assert('footer is non-scrolling chrome', /flex:\s*0\s+0\s+auto|flex-shrink:\s*0|position:\s*sticky/.test(footerCss));
assert('footer safe-area padding', /safe-area-inset-bottom/.test(footerCss));
assert('mobile full-bleed create drawer',
  apiSrc.includes('@media(max-width:640px){.portal-schedule-drawer,.portal-schedule-create-drawer{width:100vw;border-left:none}}')
  || /@media\(max-width:640px\)\{[^}]*\.portal-schedule-create-drawer\{[^}]*width:\s*100vw/.test(apiSrc.replace(/\s+/g, '')));
assert('thumb-friendly footer actions',
  /portal-schedule-create-actions/.test(footerCss + apiSrc)
  && (/min-height:\s*4[4-9]px|min-height:\s*[5-9]\dpx/.test(footerCss + apiSrc) || /gap:\s*1[0-2]px/.test(footerCss)));
assert('light/dark tokens retained (no new design language)',
  apiSrc.includes(':root:not([data-theme="dark"]) #tab-portal-home .portal-schedule-create-drawer{background:var(--cream)')
  && apiSrc.includes('[data-theme="dark"] #tab-portal-home .portal-schedule-create-drawer{background:var(--surface)'));
assert('schedule-green accent retained',
  apiSrc.includes('--sched-primary') || apiSrc.includes('#4E5853') || apiSrc.includes('#2F6B4F'));

console.log('\n[9] Accessibility');
assert('title id anchors aria-labelledby', /id="ps-create-title"/.test(modalHtml));
assert('X has aria-label', /id="ps-create-close"[^>]*aria-label=/.test(modalHtml));
assert('section headings present', (modalHtml.match(/portal-schedule-create-section-title|data-create-section=/g) || []).length >= 4);
assert('visible focus style available for close/actions',
  /:focus-visible/.test(apiSrc) || /\.btn:focus/.test(apiSrc) || /outline/.test(apiSrc));
assert('no invented focus trap',
  !/focus-trap|trapFocus|createFocusTrap|inert=/.test(modalHtml)
  && !/ps-create.*focusTrap|trapFocus.*ps-create/.test(apiSrc));

console.log('\n[10] Module contracts still resolve create controls by id');
assert('portal module writes quote into ps-create-quote-preview', portalSrc.includes("el('ps-create-quote-preview')"));
assert('portal submit still targets ps-create-submit',
  portalSrc.includes("el('ps-create-submit')") || apiSrc.includes("el('ps-create-submit')"));
assert('portal status still targets ps-create-msg',
  portalSrc.includes("el('ps-create-msg')") || apiSrc.includes("el('ps-create-msg')"));

if (portalSrc.includes('function schedulePortalRenderCreateQuotePreview')) {
  const sandbox = {
    el: function (id) {
      if (id === 'ps-create-quote-preview') return { innerHTML: '', style: { display: 'none' } };
      return null;
    },
    escHtml: function (s) {
      return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
    },
    portalT: function (k) { return k; },
  };
  const fnMatch = portalSrc.match(/function schedulePortalRenderCreateQuotePreview\([\s\S]*?\n\}/);
  try {
    if (!fnMatch) throw new Error('extract failed');
    vm.runInNewContext(fnMatch[0] + '\nschedulePortalRenderCreateQuotePreview({ ok: true, body: { total_cents: 2500 } });', sandbox);
    assert('quote preview contract executes without throw', true);
  } catch (err) {
    assert('quote preview contract executes without throw', false, err && err.message);
  }
} else {
  assert('portal quote preview function present', false);
}

[
  "el('ps-create-guest')", "el('ps-create-phone')", "el('ps-create-date-from')",
  "el('ps-create-date-to')", "el('ps-create-payment')", "el('ps-create-notes')",
  "el('ps-create-comp-course')", "el('ps-create-comp-private-lesson')",
].forEach((needle) => {
  assert('payload wiring still references ' + needle, apiSrc.includes(needle) || portalSrc.includes(needle));
});

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:sunset-booking-create-shell — FAILED');
  process.exit(1);
}
console.log('verify:sunset-booking-create-shell — ALL CHECKS PASSED');
process.exit(0);
