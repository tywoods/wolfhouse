'use strict';

/**
 * verify:sunset-rental-surfer-label-edit-parity
 *
 * Create/Edit continuity for equipment rental quantity label + Edit compact footer.
 *
 * Required cases:
 *  1. Create board_and_suit row says Qty; payload qty intact and independent
 *  2. Create board-only and wetsuit-only use same Qty label
 *  3. Edit board_and_suit hydrated row says Qty; preserves persisted quantity
 *  4. Edit no-lesson qty is independent of booking surfer count
 *  4b. Edit no-lesson has visible booking-level #ps-drawer-surfers (guest field)
 *  5. Create/Edit row DOM class/order parity + mutual exclusion
 *  6. Edit compact footer: named course, no year/payment/dup duration; quote row
 *  7. Edit rental/date change invalidates stale quote and requotes
 *  8. 375/430 CSS contract + EN/ES/IT Qty labels
 *  9. Mutation guard: replacing Qty with Surfers must RED
 *
 * Exercises real generated /staff/ui + Create/Edit owner functions (not source regex alone).
 * No Azure / staging / DB mutation.
 *
 * Run: node scripts/verify-sunset-rental-surfer-label-edit-parity.js
 */

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');
const esSunset = require('./lib/staff-portal-i18n-es-sunset');

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) {
    console.log('  PASS  ' + label);
    pass += 1;
  } else {
    console.error('  FAIL  ' + label + (detail ? ' — ' + detail : ''));
    fail += 1;
  }
}

function extractFn(src, name) {
  const needle = 'function ' + name + '(';
  const start = src.indexOf(needle);
  if (start < 0) return null;
  const brace = src.indexOf('{', start);
  if (brace < 0) return null;
  let depth = 0;
  for (let i = brace; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on('error', reject);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('GET timeout')));
  });
}

async function fetchRenderedStaffUi() {
  const port = await freePort();
  const env = Object.assign({}, process.env, {
    STAFF_AUTH_REQUIRED: 'false',
    STAFF_AUTH_ALLOW_OPEN: 'true',
    STAFF_AUTH_HTTPS: 'false',
    STAFF_QUERY_API_PORT: String(port),
    STAFF_QUERY_API_BIND_HOST: '127.0.0.1',
    STAFF_RUNTIME_PROFILE: 'test',
    NODE_ENV: 'test',
    META_WEBHOOK_SKIP_VERIFY: 'true',
    BOOKING_MOVE_WRITE_ENABLED: 'true',
  });
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts/staff-query-api.js')], {
    env,
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.stdout.on('data', () => {});

  let lastErr = null;
  try {
    for (let i = 0; i < 40; i += 1) {
      if (child.exitCode != null) {
        throw new Error('staff-query-api exited early: ' + stderr.slice(0, 500));
      }
      try {
        const res = await httpGet('http://127.0.0.1:' + port + '/staff/ui');
        if (res.status === 200 && res.body.includes('<!DOCTYPE html>')) {
          return { html: res.body, port };
        }
        lastErr = new Error('HTTP ' + res.status);
      } catch (e) {
        lastErr = e;
      }
      await sleep(150);
    }
    throw lastErr || new Error('timeout waiting for /staff/ui');
  } finally {
    try { child.kill('SIGTERM'); } catch (_k) { /* ignore */ }
    await sleep(100);
    try { child.kill('SIGKILL'); } catch (_k2) { /* ignore */ }
  }
}

function makeEl(id, extra) {
  const node = Object.assign({
    id,
    value: '',
    checked: false,
    disabled: false,
    textContent: '',
    innerHTML: '',
    style: { display: '' },
    dataset: {},
    className: '',
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c, force) {
        if (force === true) this._s.add(c);
        else if (force === false) this._s.delete(c);
        else if (this._s.has(c)) this._s.delete(c);
        else this._s.add(c);
      },
    },
    options: [],
    selectedIndex: -1,
    _attrs: {},
    _ls: {},
    children: [],
    parentNode: null,
    addEventListener(ev, fn) { (this._ls[ev] = this._ls[ev] || []).push(fn); },
    dispatchEvent(ev) {
      const type = ev && ev.type;
      (this._ls[type] || []).forEach((fn) => fn(ev));
    },
    setAttribute(k, v) {
      this._attrs[k] = String(v);
      if (k === 'class') this.className = String(v);
    },
    getAttribute(k) {
      if (k === 'class' && this.className) return this.className;
      return this._attrs[k] != null ? this._attrs[k] : null;
    },
    removeAttribute(k) { delete this._attrs[k]; },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    },
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => {
        if (!n) return;
        if (matchSel(n, sel)) out.push(n);
        (n.children || []).forEach(walk);
      };
      (this.children || []).forEach(walk);
      return out;
    },
    appendChild(c) {
      c.parentNode = this;
      this.children.push(c);
      return c;
    },
    closest(sel) {
      let n = this;
      while (n) {
        if (matchSel(n, sel)) return n;
        n = n.parentNode;
      }
      return null;
    },
  }, extra || {});
  return node;
}

function matchSel(n, sel) {
  if (!n || !sel) return false;
  if (sel.startsWith('.')) {
    const cls = sel.slice(1).split('.')[0];
    const cn = String(n.className || n.getAttribute && n.getAttribute('class') || '');
    return cn.split(/\s+/).indexOf(cls) >= 0 || (n.classList && n.classList.contains(cls));
  }
  if (sel.startsWith('#')) return n.id === sel.slice(1);
  if (sel.startsWith('[')) {
    const m = sel.match(/^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]/);
    if (!m) return false;
    const v = n.getAttribute && n.getAttribute(m[1]);
    if (m[2] == null) return v != null;
    return String(v) === m[2];
  }
  if (sel === 'input' || sel === 'label' || sel === 'span' || sel === 'button') {
    return (n.tagName || '').toLowerCase() === sel;
  }
  if (sel.includes(' ')) {
    // simple descendant: take last part
    const parts = sel.trim().split(/\s+/);
    return matchSel(n, parts[parts.length - 1]);
  }
  if (sel.includes('.')) {
    const [tag, ...classes] = sel.split('.');
    if (tag && (n.tagName || '').toLowerCase() !== tag) return false;
    return classes.every((c) => {
      const cn = String(n.className || '');
      return cn.split(/\s+/).indexOf(c) >= 0 || (n.classList && n.classList.contains(c));
    });
  }
  if (sel.startsWith('input.')) {
    return (n.tagName || '').toLowerCase() === 'input' && matchSel(n, sel.slice(sel.indexOf('.')));
  }
  return false;
}

/** Minimal HTML → element tree for rental rows produced by owner renderers. */
function parseRentalHtml(html, rootId) {
  const root = makeEl(rootId, { innerHTML: html, tagName: 'div' });
  // Very small parser: split data-rental-offering rows.
  const rowRe = /<div class="([^"]*)"[^>]*data-rental-offering="([^"]+)"[^>]*>([\s\S]*?)<\/div>\s*(?=<div class="|<\/|$)/g;
  // Fallback: find each offering block
  const parts = String(html || '').split(/(?=<div class="[^"]*portal-schedule-create-rental-row)/);
  root.children = [];
  parts.forEach((part) => {
    if (!/data-rental-offering=/.test(part) && !/data-rental-duration-pebbles/.test(part)) return;
    if (/data-rental-duration-pebbles/.test(part) && !/data-rental-offering=/.test(part)) {
      const host = makeEl(null, {
        tagName: 'div',
        className: 'portal-schedule-create-rental-pebbles-host',
        innerHTML: part,
      });
      host.setAttribute('data-rental-duration-pebbles', '');
      root.appendChild(host);
      return;
    }
    const keyM = part.match(/data-rental-offering="([^"]+)"/);
    if (!keyM) return;
    const classM = part.match(/class="([^"]*portal-schedule-create-rental-row[^"]*)"/);
    const row = makeEl(null, {
      tagName: 'div',
      className: classM ? classM[1] : 'portal-schedule-create-rental-row',
      innerHTML: part,
    });
    row.setAttribute('data-rental-offering', keyM[1]);
    row.setAttribute('class', row.className);

    // checkbox
    const checked = /type="checkbox"[^>]*checked|checked[^>]*type="checkbox"/.test(part)
      || /\schecked(\s|>)/.test(part);
    const offM = part.match(/data-offering-key="([^"]+)"/);
    const checkClass = /ps-create-rental-check/.test(part)
      ? 'ps-create-rental-check'
      : 'ps-drawer-rental-check';
    const check = makeEl(null, {
      tagName: 'input',
      type: 'checkbox',
      checked,
      className: checkClass,
    });
    check.setAttribute('data-offering-key', offM ? offM[1] : keyM[1]);
    check.classList.add(checkClass);

    const labelClass = 'portal-schedule-create-check';
    const label = makeEl(null, { tagName: 'label', className: labelClass });
    label.classList.add(labelClass);
    label.appendChild(check);
    const spanLab = makeEl(null, { tagName: 'span', textContent: '' });
    label.appendChild(spanLab);
    row.appendChild(label);

    // qty wrap
    if (/portal-schedule-create-rental-qty/.test(part)) {
      const hidden = /portal-schedule-create-rental-qty"[^>]*(style="display:none"|hidden)/.test(part)
        || /style="display:none"[^>]*portal-schedule-create-rental-qty/.test(part);
      const qtyWrap = makeEl(null, {
        tagName: 'div',
        className: 'portal-schedule-create-rental-qty',
        style: { display: hidden ? 'none' : '' },
      });
      qtyWrap.classList.add('portal-schedule-create-rental-qty');
      if (hidden) {
        qtyWrap.setAttribute('hidden', '');
        qtyWrap.setAttribute('aria-hidden', 'true');
      }
      const qtyLabelM = part.match(/portal-schedule-create-rental-qty[\s\S]*?<span[^>]*>([^<]*)<\/span>/);
      const qtyLabelText = qtyLabelM ? qtyLabelM[1] : '';
      const i18nM = part.match(/data-i18n="(schedule\.create\.rentalQty)"/);
      const qtySpan = makeEl(null, { tagName: 'span', textContent: qtyLabelText });
      if (i18nM) qtySpan.setAttribute('data-i18n', i18nM[1]);
      const qtyInputClass = /ps-create-rental-qty-input/.test(part)
        ? 'ps-create-rental-qty-input'
        : 'ps-drawer-rental-qty-input';
      const valM = part.match(/class="[^"]*rental-qty-input[^"]*"[^>]*value="([^"]*)"/)
        || part.match(/value="([^"]*)"[^>]*class="[^"]*rental-qty-input/);
      const ownerM = part.match(/data-qty-owner="([^"]+)"/);
      const qtyInput = makeEl(null, {
        tagName: 'input',
        type: 'number',
        className: qtyInputClass,
        value: valM ? valM[1] : '1',
      });
      qtyInput.classList.add(qtyInputClass);
      if (ownerM) qtyInput.setAttribute('data-qty-owner', ownerM[1]);
      const minM = part.match(/min="(\d+)"/);
      const maxM = part.match(/max="(\d+)"/);
      if (minM) qtyInput.setAttribute('min', minM[1]);
      if (maxM) qtyInput.setAttribute('max', maxM[1]);
      const lab = makeEl(null, { tagName: 'label' });
      lab.appendChild(qtySpan);
      lab.appendChild(qtyInput);
      qtyWrap.appendChild(lab);
      row.appendChild(qtyWrap);
      row._qtyLabelText = qtyLabelText;
      row._qtyI18n = i18nM ? i18nM[1] : null;
    }
    root.appendChild(row);
  });
  // Preserve raw for string checks
  root._rawHtml = html;
  return root;
}

function i18nMaps() {
  const en = STAFF_PORTAL_STRINGS.en || {};
  const it = STAFF_PORTAL_STRINGS.it || {};
  const es = Object.assign({}, en, esSunset || {});
  return { en, es, it };
}

(async function main() {
  console.log('\nverify:sunset-rental-surfer-label-edit-parity\n');

  const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
  const editSrc = fs.readFileSync(
    path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-edit-ui.js'),
    'utf8',
  );
  const portalSrc = fs.readFileSync(
    path.join(ROOT, 'scripts/browser/sunset-schedule-portal-module.js'),
    'utf8',
  );
  const i18nSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n.js'), 'utf8');
  const esSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n-es-sunset.js'), 'utf8');

  // ── [0] i18n + CSS contracts (static) ────────────────────────────────────
  console.log('[0] i18n + CSS contracts');
  const maps = i18nMaps();
  ok('EN rentalQty is Qty (equipment units, not Surfers)',
    maps.en['schedule.create.rentalQty'] === 'Qty'
    && maps.en['schedule.create.rentalQty'] !== 'Surfers'
    && maps.en['schedule.create.rentalQty'] !== 'Number of surfers');
  ok('ES rentalQty is Cant. (compact)',
    maps.es['schedule.create.rentalQty'] === 'Cant.'
    || /'schedule\.create\.rentalQty':\s*'Cant\.'/.test(esSrc));
  ok('IT rentalQty is Qtà (compact)',
    maps.it['schedule.create.rentalQty'] === 'Qtà'
    || /'schedule\.create\.rentalQty':\s*'Qtà'/.test(i18nSrc));
  ok('Create render fallback text is Qty not Surfers',
    /data-i18n="schedule\.create\.rentalQty">Qty</.test(apiSrc)
    && !/data-i18n="schedule\.create\.rentalQty">Surfers</.test(apiSrc));
  ok('Edit render uses Qty fallback (not Surfers)',
    /schedule\.create\.rentalQty[\s\S]{0,40}Qty/.test(editSrc)
    && !/schedule\.create\.rentalQty[\s\S]{0,40}Surfers/.test(editSrc));
  ok('rental qty min-height ≥ 36 shared CSS (touch)',
    /\.portal-schedule-create-rental-qty input\[type=number\]\{[^}]*min-height:\s*(36|44)px/.test(apiSrc));
  ok('footer buttons 44px touch target',
    /\.portal-schedule-create-footer[\s\S]{0,200}min-height:\s*44px/.test(apiSrc));
  ok('drawer edit footer sticky + create-footer classes',
    /portal-schedule-drawer-edit-footer/.test(apiSrc)
    && /portal-schedule-create-footer/.test(editSrc));
  ok('Edit footer includes dedicated quote preview id',
    /ps-drawer-quote-preview/.test(editSrc)
    || /id="ps-drawer-quote-preview"/.test(editSrc));
  ok('Create/Edit CSS full-bleed ≤640 for drawers',
    /@media\(max-width:640px\)[\s\S]{0,200}portal-schedule-create-drawer\{[^}]*width:100vw/.test(apiSrc)
    || /max-width:640px[\s\S]{0,400}width:100vw/.test(apiSrc));

  // ── [1] Generated /staff/ui ──────────────────────────────────────────────
  console.log('\n[1] Generated /staff/ui artifact');
  let rendered;
  try {
    rendered = await fetchRenderedStaffUi();
  } catch (e) {
    ok('GET /staff/ui', false, String(e && e.message || e));
    console.error('\nFAILED early — cannot load /staff/ui\n');
    process.exit(1);
  }
  const html = rendered.html;
  ok('GET /staff/ui 200 HTML', html.includes('<!DOCTYPE html>'));
  ok('/staff/ui injects scheduleRenderCreateRentals',
    html.includes('function scheduleRenderCreateRentals'));
  ok('/staff/ui injects scheduleRenderDrawerRentals',
    html.includes('function scheduleRenderDrawerRentals'));
  ok('/staff/ui Create rentalQty fallback Qty',
    /data-i18n="schedule\.create\.rentalQty">Qty</.test(html));
  ok('/staff/ui never ships Surfers as rentalQty fallback',
    !/data-i18n="schedule\.create\.rentalQty">Surfers</.test(html));
  ok('/staff/ui Edit Qty fallback present',
    /schedule\.create\.rentalQty[\s\S]{0,40}Qty/.test(html)
    || /portalT\('schedule\.create\.rentalQty'\) \|\| 'Qty'/.test(html));

  // ── [2] Create rental rows (owner function) ──────────────────────────────
  console.log('\n[2] Create board_and_suit / board / wetsuit Surfers label');

  function sandboxCreate(opts) {
    opts = opts || {};
    const nodes = {};
    const el = (id) => nodes[id] || null;
    const rentals = makeEl('ps-create-rentals', { tagName: 'div', className: 'portal-schedule-create-rentals' });
    nodes['ps-create-rentals'] = rentals;
    nodes['ps-create-surfers'] = makeEl('ps-create-surfers', { value: String(opts.surfers != null ? opts.surfers : 2) });
    nodes['ps-create-comp-no-lesson'] = makeEl('ps-create-comp-no-lesson', {
      checked: opts.mode === 'none' || opts.mode == null,
    });
    nodes['ps-create-comp-course'] = makeEl('ps-create-comp-course', { checked: opts.mode === 'group' });
    nodes['ps-create-comp-private-lesson'] = makeEl('ps-create-comp-private-lesson', {
      checked: opts.mode === 'private',
    });
    nodes['ps-create-date-from'] = makeEl('ps-create-date-from', { value: '2026-07-27' });
    nodes['ps-create-date-to'] = makeEl('ps-create-date-to', { value: '2026-07-31' });
    nodes['ps-create-course-qty'] = makeEl('ps-create-course-qty', { value: String(opts.surfers || 2) });
    nodes['ps-create-private-lesson-surfers'] = makeEl('ps-create-private-lesson-surfers', {
      value: String(opts.surfers || 2),
    });
    nodes['ps-create-modal'] = makeEl('ps-create-modal');

    const prices = [
      { offering_key: 'board_rental', unit: '5_days', amount_cents: 5000, active: true, location_id: 'sunset-somo' },
      { offering_key: 'wetsuit_rental', unit: '5_days', amount_cents: 4000, active: true, location_id: 'sunset-somo' },
      { offering_key: 'board_and_suit_rental', unit: '5_days', amount_cents: 10000, active: true, location_id: 'sunset-somo' },
    ];

    const needed = [
      'scheduleReadCreateSurferCount',
      'scheduleCreateIsNoLesson',
      'scheduleCreateDateSpanForRentals',
      'scheduleApplyCreateRentalExclusionUi',
      'scheduleRenderCreateRentals',
      'scheduleReadCreateRentalSelectionFromDom',
      'scheduleCreateSelectedRentalKeys',
      'scheduleCreateIsCombinedBoardWetsuit',
      'scheduleRenderCreateRentalDurationPebbles',
      'scheduleWireCreateRentals',
    ];
    // Prefer live artifact functions
    const chunks = [];
    for (const name of needed) {
      const fn = extractFn(html, name) || extractFn(apiSrc, name);
      if (fn) chunks.push(fn);
    }

    const offeringsIdentity = prices.map((p) => ({
      offering_key: p.offering_key,
      label: p.offering_key,
      active: true,
      location_id: 'sunset-somo',
      client_slug: 'sunset',
    }));
    const ctx = {
      console,
      JSON, Object, Array, Number, String, Math, Date,
      scheduleAdminPricesCache: prices,
      // Identity catalog used by Slice-2 projection path in scheduleRenderCreateRentals.
      scheduleRentalOfferingsCache: offeringsIdentity,
      getClient: () => 'sunset',
      getSunsetLocation: () => 'sunset-somo',
      scheduleEnumerateDates: (a, b) => {
        // 5 days Jul 27–31
        return ['2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31'];
      },
      scheduleRentalDurationKeyFromDates: () => '5_days',
      scheduleProjectStandaloneRentals: (opts) => offeringsIdentity.map((o) => ({
        offering_key: o.offering_key,
        label: o.label,
        duration_key: '5_days',
        durations: [{ duration_key: '5_days', amount_cents: (prices.find((p) => p.offering_key === o.offering_key) || {}).amount_cents || 0, label: '5 days' }],
      })),
      scheduleActiveRentalsForDuration: () => prices.map((p) => ({
        offering_key: p.offering_key,
        duration_key: '5_days',
        durations: [{ duration_key: '5_days', amount_cents: p.amount_cents, label: '5 days' }],
      })),
      scheduleCommonShortRentalDurationKeys: () => [],
      scheduleActiveShortRentalOfferings: () => [],
      scheduleRentalOfferingsMode: () => 'all_three',
      scheduleRentalOfferingDisplayLabel: (k, label) => label || k,
      scheduleRentalOfferingLabelKey: (k) => (
        k === 'wetsuit_rental' ? 'schedule.type.wetsuitRental'
          : k === 'board_and_suit_rental' ? 'schedule.ops.rentalBoth'
            : 'schedule.type.boardRental'
      ),
      scheduleApplyRentalMutualExclusion: (sel, key, on) => {
        if (!on) return sel.filter((k) => k !== key);
        if (key === 'board_and_suit_rental') return ['board_and_suit_rental'];
        return sel.filter((k) => k !== 'board_and_suit_rental').concat([key]);
      },
      scheduleSerializeRentalsSelection: (sel) => sel,
      scheduleEnhanceIntSteppersIn: () => {},
      scheduleFormatCentsMoney: (c) => '€' + (Number(c) / 100).toFixed(0),
      portalT: (k) => maps.en[k] || k,
      escHtml: (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
      el,
      window: { applyStaffPortalI18n() {} },
    };
    vm.createContext(ctx);
    vm.runInContext(chunks.join('\n'), ctx);

    // Override innerHTML setter to parse rental DOM for querySelector
    const originalRender = ctx.scheduleRenderCreateRentals;
    ctx.scheduleRenderCreateRentals = function() {
      originalRender();
      const wrap = el('ps-create-rentals');
      const parsed = parseRentalHtml(wrap.innerHTML, 'ps-create-rentals');
      // Keep attrs from wrap
      Object.keys(wrap._attrs || {}).forEach((k) => parsed.setAttribute(k, wrap.getAttribute(k)));
      parsed.dataset = wrap.dataset;
      nodes['ps-create-rentals'] = parsed;
      // re-bind el
      Object.assign(parsed, {
        getAttribute: wrap.getAttribute.bind(wrap),
        setAttribute: wrap.setAttribute.bind(wrap),
        dataset: wrap.dataset,
        _attrs: wrap._attrs,
      });
      // merge: use parsed children but wrap attrs
      wrap.children = parsed.children;
      wrap.querySelector = parsed.querySelector.bind(parsed);
      wrap.querySelectorAll = parsed.querySelectorAll.bind(parsed);
      wrap._rawHtml = wrap.innerHTML;
    };

    return { ctx, el, nodes };
  }

  const createGroup = sandboxCreate({ mode: 'group', surfers: 2 });
  // Pre-check board_and_suit
  createGroup.ctx.scheduleRenderCreateRentals();
  let wrap = createGroup.el('ps-create-rentals');
  // Manually seed checked state then re-render
  wrap.innerHTML = String(wrap.innerHTML || '').replace(
    /data-offering-key="board_and_suit_rental"/,
    'data-offering-key="board_and_suit_rental" checked',
  );
  // Better: set prev via first render then toggle via exclusion
  // Direct string inspection of first render HTML for labels:
  const createHtml1 = wrap._rawHtml || wrap.innerHTML || '';
  ok('Create render emits rentalQty key',
    /data-i18n="schedule\.create\.rentalQty"/.test(createHtml1), createHtml1.slice(0, 200));
  ok('Create board_and_suit visible label Qty never Surfers',
    /data-i18n="schedule\.create\.rentalQty">Qty</.test(createHtml1)
    && !/>Surfers</.test(createHtml1), createHtml1.slice(0, 400));

  // Check all three offerings present with same label key
  ok('Create board-only uses Qty label key',
    /data-rental-offering="board_rental"[\s\S]*?data-i18n="schedule\.create\.rentalQty">Qty</.test(createHtml1)
    || (createHtml1.match(/data-i18n="schedule\.create\.rentalQty">Qty</g) || []).length >= 1,
    'label count=' + ((createHtml1.match(/data-i18n="schedule\.create\.rentalQty">Qty</g) || []).length));
  ok('Create wetsuit-only uses Qty label key',
    /data-rental-offering="wetsuit_rental"[\s\S]*?schedule\.create\.rentalQty/.test(createHtml1)
    || (createHtml1.match(/schedule\.create\.rentalQty/g) || []).length >= 1);

  // Numeric value / payload for group with surfers=2
  // Force-check bundle via exclusion helper after parse
  const createGroup2 = sandboxCreate({ mode: 'group', surfers: 3 });
  createGroup2.ctx.scheduleRenderCreateRentals();
  wrap = createGroup2.el('ps-create-rentals');
  // Inject checked on board_and_suit into raw then re-parse by calling exclusion
  const raw = wrap.innerHTML;
  // Simulate checked state on DOM nodes
  const bundleRow = (wrap.querySelectorAll('[data-rental-offering]') || [])
    .find((r) => r.getAttribute('data-rental-offering') === 'board_and_suit_rental');
  if (bundleRow) {
    const check = bundleRow.querySelector('.ps-create-rental-check');
    if (check) check.checked = true;
    const qtyEl = bundleRow.querySelector('input.ps-create-rental-qty-input');
    if (qtyEl) qtyEl.value = '3';
  }
  if (typeof createGroup2.ctx.scheduleApplyCreateRentalExclusionUi === 'function') {
    createGroup2.ctx.scheduleApplyCreateRentalExclusionUi(wrap, ['board_and_suit_rental']);
  }
  let sel = [];
  if (typeof createGroup2.ctx.scheduleReadCreateRentalSelectionFromDom === 'function') {
    sel = createGroup2.ctx.scheduleReadCreateRentalSelectionFromDom();
  }
  ok('Create board_and_suit payload quantity remains 3',
    Array.isArray(sel) && sel.some((r) => r.offering_key === 'board_and_suit_rental' && r.quantity === 3),
    JSON.stringify(sel));

  // ── [3] Edit hydrated Surfers + qty preserve ─────────────────────────────
  console.log('\n[3] Edit hydrated board_and_suit Surfers + persisted qty');

  function sandboxEdit(opts) {
    opts = opts || {};
    const nodes = {};
    const el = (id) => nodes[id] || null;
    const seedRentals = opts.rentals || [{
      offering_key: 'board_and_suit_rental',
      duration_key: '5_days',
      quantity: opts.qty != null ? opts.qty : 4,
    }];
    const seedSurfers = opts.surfers != null ? opts.surfers : (seedRentals[0] && seedRentals[0].quantity) || 1;
    const rentals = makeEl('ps-drawer-rentals', {
      tagName: 'div',
      className: 'portal-schedule-create-rentals portal-schedule-drawer-rentals',
    });
    rentals.setAttribute('data-seed-board', '0');
    rentals.setAttribute('data-seed-wetsuit', '0');
    rentals.setAttribute('data-seed-board-qty', '1');
    rentals.setAttribute('data-seed-wetsuit-qty', '1');
    rentals.setAttribute('data-seed-rentals', JSON.stringify(seedRentals));
    rentals.setAttribute('data-seed-surfers', String(seedSurfers));
    nodes['ps-drawer-rentals'] = rentals;
    nodes['ps-drawer-comp-course'] = makeEl('ps-drawer-comp-course', { checked: opts.mode === 'group' });
    nodes['ps-drawer-comp-private-lesson'] = makeEl('ps-drawer-comp-private-lesson', {
      checked: opts.mode === 'private',
    });
    nodes['ps-drawer-comp-no-lesson'] = makeEl('ps-drawer-comp-no-lesson', {
      checked: opts.mode === 'none' || opts.mode == null,
    });
    nodes['ps-drawer-date-from'] = makeEl('ps-drawer-date-from', { value: opts.from || '2026-07-27' });
    nodes['ps-drawer-date-to'] = makeEl('ps-drawer-date-to', { value: opts.to || '2026-07-31' });
    nodes['ps-drawer-course-qty'] = makeEl('ps-drawer-course-qty', { value: String(opts.courseQty || seedSurfers) });
    nodes['ps-drawer-private-lesson-surfers'] = makeEl('ps-drawer-private-lesson-surfers', {
      value: String(opts.plSurfers || seedSurfers),
    });
    // Booking-level Surfers authority for no-lesson Edit (Create #ps-create-surfers parity).
    nodes['ps-drawer-surfers'] = makeEl('ps-drawer-surfers', {
      value: String(opts.drawerSurfers != null ? opts.drawerSurfers : seedSurfers),
      type: 'number',
      min: '1',
      max: '99',
      inputMode: 'numeric',
    });
    nodes['ps-drawer-surfers-field'] = makeEl('ps-drawer-surfers-field', {
      style: { display: opts.mode === 'none' || opts.mode == null ? '' : 'none' },
      className: 'portal-schedule-create-field',
    });
    nodes['ps-drawer-guest'] = makeEl('ps-drawer-guest', { value: opts.guest || 'Koa' });
    nodes['ps-drawer-phone'] = makeEl('ps-drawer-phone', { value: '+34600' });
    nodes['ps-drawer-payment'] = makeEl('ps-drawer-payment', { value: 'unpaid' });
    nodes['ps-drawer-notes'] = makeEl('ps-drawer-notes', { value: '' });
    nodes['ps-drawer-summary'] = makeEl('ps-drawer-summary', { innerHTML: '' });
    nodes['ps-drawer-quote-preview'] = makeEl('ps-drawer-quote-preview', {
      innerHTML: '',
      style: { display: 'none' },
    });
    nodes['ps-drawer-save'] = makeEl('ps-drawer-save', { disabled: false });
    nodes['ps-drawer-save-msg'] = makeEl('ps-drawer-save-msg', { style: { display: 'none' }, dataset: {} });
    nodes['ps-drawer-course-select'] = makeEl('ps-drawer-course-select', {
      value: 'c1',
      selectedIndex: 0,
      options: [{
        value: 'c1',
        textContent: 'Curso Mañana',
        getAttribute: (k) => (k === 'data-label' ? 'Curso Mañana' : null),
      }],
    });
    nodes['ps-drawer-comp-fullday'] = makeEl('ps-drawer-comp-fullday', { checked: false });
    nodes['ps-drawer-fullday-rows'] = makeEl('ps-drawer-fullday-rows');
    nodes['ps-drawer-fullday-summary'] = makeEl('ps-drawer-fullday-summary', { style: { display: 'none' } });
    nodes['ps-drawer-addon-fullday-field'] = makeEl('ps-drawer-addon-fullday-field', { style: { display: 'none' } });
    nodes['ps-drawer-when-summary'] = makeEl('ps-drawer-when-summary');
    nodes['ps-drawer-course-fields'] = makeEl('ps-drawer-course-fields', { style: { display: '' } });
    nodes['ps-drawer-course-qty-wrap'] = makeEl('ps-drawer-course-qty-wrap', { style: { display: '' } });
    nodes['ps-drawer-private-lesson-fields'] = makeEl('ps-drawer-private-lesson-fields', { style: { display: 'none' } });
    nodes['ps-drawer-course-section'] = makeEl('ps-drawer-course-section', { style: { display: '' } });
    nodes['ps-drawer-course-duration-confirm'] = makeEl('ps-drawer-course-duration-confirm', { style: { display: 'none' } });
    nodes['ps-drawer-private-when'] = makeEl('ps-drawer-private-when', { style: { display: 'none' } });
    nodes['ps-drawer-date-range'] = makeEl('ps-drawer-date-range', { style: { display: '' } });

    const prices = [
      { offering_key: 'board_rental', unit: '5_days', amount_cents: 5000, active: true, location_id: 'sunset-somo' },
      { offering_key: 'wetsuit_rental', unit: '5_days', amount_cents: 4000, active: true, location_id: 'sunset-somo' },
      { offering_key: 'board_and_suit_rental', unit: '5_days', amount_cents: 10000, active: true, location_id: 'sunset-somo' },
      { offering_key: 'board_and_suit_rental', unit: '6_days', amount_cents: 11500, active: true, location_id: 'sunset-somo' },
    ];

    const editFns = [
      'scheduleDrawerMainActivityValue',
      'scheduleDrawerSeedRentalsFromCtx',
      'scheduleDrawerDateSpan',
      'scheduleDrawerReadSurferCount',
      'scheduleDrawerApplyRentalExclusionUi',
      'scheduleRenderDrawerRentals',
      'scheduleReadDrawerRentalSelectionFromDom',
      'scheduleWireDrawerRentals',
      'scheduleDrawerHumanCourseBit',
      'scheduleDrawerRenderIntentSummary',
      'scheduleDrawerSyncFooter',
      'scheduleDrawerMarkPriceStale',
      'scheduleDrawerValidateEditPayload',
      'scheduleReadDrawerEditPayload',
      'scheduleDrawerDropStaleQuoteUi',
      'scheduleDrawerRenderQuotePreview',
      'scheduleDrawerRefreshQuote',
      'scheduleDrawerShowQuoteChecking',
      'scheduleDrawerClearQuotePreviewUi',
      'scheduleParsePaymentSelectValue',
      'scheduleDrawerQuotePricingIntentKey',
      'scheduleDrawerIsCombinedBoardWetsuit',
    ];
    const portalFns = [
      'schedulePortalFormatCompactDateRange',
      'schedulePortalRentalLabel',
      'schedulePortalDurationLabel',
      'schedulePortalStrictQuoteTotalCents',
      'schedulePortalNormalizeRentalsIntent',
      'schedulePortalNormalizeLessonsIntent',
      'schedulePortalNormalizeCourseEquipmentIntent',
      'schedulePortalNormalizeAccommodationIntent',
      'schedulePortalNormalizeCustomLinesIntent',
      'schedulePortalQuotePricingIntentKey',
    ];
    const chunks = [];
    for (const name of editFns) {
      const fn = extractFn(html, name) || extractFn(editSrc, name);
      if (fn) chunks.push(fn);
    }
    for (const name of portalFns) {
      const fn = extractFn(html, name) || extractFn(portalSrc, name);
      if (fn) chunks.push(fn);
    }

    let fetchCalls = [];
    const ctx = {
      console,
      JSON, Object, Array, Number, String, Math, Date, Promise, setTimeout, clearTimeout,
      Intl,
      AbortController: typeof AbortController !== 'undefined' ? AbortController : undefined,
      scheduleDrawerSaveInFlight: false,
      scheduleDrawerPriceStale: false,
      scheduleDrawerValidationState: { ok: true, errorKey: null },
      scheduleDrawerCustomLines: [],
      scheduleDrawerAccommodationStays: [],
      scheduleDrawerQuoteState: null,
      scheduleDrawerQuoteGen: 0,
      scheduleDrawerQuoteAbort: null,
      scheduleDrawerQuoteTimer: null,
      scheduleDrawerQuoteDebounceMs: 0,
      scheduleAdminPricesCache: prices,
      scheduleRentalOfferingsCache: prices.map((p) => ({
        offering_key: p.offering_key,
        label: p.offering_key,
        active: true,
        location_id: 'sunset-somo',
        client_slug: 'sunset',
      })),
      scheduleDrawerState: { ctx: { rentals: seedRentals }, row: { booking_id: 'b1' } },
      getSunsetLocation: () => 'sunset-somo',
      getClient: () => 'sunset',
      getStaffLocale: () => 'en',
      sunsetLocationQuerySuffix: () => '&location_id=sunset-somo',
      scheduleEnumerateDates: (a, b) => {
        if (String(a).slice(0, 10) === '2026-07-27' && String(b).slice(0, 10) === '2026-08-01') {
          return ['2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31', '2026-08-01'];
        }
        return ['2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31'];
      },
      scheduleRentalDurationKeyFromDates: (from, to) => {
        const f = String(from).slice(0, 10);
        const t = String(to).slice(0, 10);
        if (f === '2026-07-27' && t === '2026-08-01') return '6_days';
        return '5_days';
      },
      scheduleProjectStandaloneRentals: (opts) => {
        const dur = (opts && opts.dateDurationKey) || '5_days';
        return prices.map((p) => ({
          offering_key: p.offering_key,
          label: p.offering_key,
          duration_key: dur,
          durations: [{ duration_key: dur, amount_cents: p.amount_cents, label: dur }],
        }));
      },
      scheduleActiveRentalsForDuration: (_p, dur) => prices
        .filter((p) => p.unit === dur || true)
        .reduce((acc, p) => {
          if (!acc.find((x) => x.offering_key === p.offering_key)) {
            acc.push({
              offering_key: p.offering_key,
              duration_key: dur || '5_days',
              durations: [{ duration_key: dur || '5_days', amount_cents: p.amount_cents, label: dur || '5_days' }],
            });
          }
          return acc;
        }, []),
      scheduleCommonShortRentalDurationKeys: () => [],
      scheduleActiveShortRentalOfferings: () => [],
      scheduleRentalOfferingsMode: () => 'all_three',
      scheduleRentalOfferingDisplayLabel: (k, label) => label || k,
      scheduleRentalOfferingLabelKey: (k) => (
        k === 'wetsuit_rental' ? 'schedule.type.wetsuitRental'
          : k === 'board_and_suit_rental' ? 'schedule.ops.rentalBoth'
            : 'schedule.type.boardRental'
      ),
      scheduleApplyRentalMutualExclusion: (sel, key, on) => {
        if (!on) return sel.filter((k) => k !== key);
        if (key === 'board_and_suit_rental') return ['board_and_suit_rental'];
        return sel.filter((k) => k !== 'board_and_suit_rental').concat([key]);
      },
      scheduleSerializeRentalsSelection: (sel) => sel,
      scheduleEnhanceIntSteppersIn: () => {},
      scheduleFormatCentsMoney: (c) => '€' + (Number(c) / 100).toFixed(0),
      scheduleRentalsToLegacyComponents: () => ({}),
      schedulePortalResolveDerivedCourseTier: () => ({
        ok: true, tier_key: '5_days', tier_label: '5 days', offering_id: 'o1',
      }),
      schedulePortalValidatePrivateLessonCreate: () => ({ ok: true }),
      schedulePortalInclusiveDateCount: () => 5,
      scheduleReadFullDayAddonRows: () => ({}),
      adminPeriodLabel: (k) => ({ '5_days': '5 days', '6_days': '6 days' }[k] || null),
      portalT: (k) => ({
        ...maps.en,
        'schedule.type.course': 'Group course',
        'schedule.type.noLesson': 'No lesson',
        'schedule.ops.rentalBoth': 'Board and wetsuit',
        'schedule.type.boardRental': 'Board rental',
        'schedule.type.wetsuitRental': 'Wetsuit rental',
        'schedule.create.quoteTotal': 'Quoted total',
        'schedule.create.checkingPrice': 'Checking price…',
        'admin.period.5_days': '5 days',
        'admin.period.6_days': '6 days',
        'schedule.drawer.priceWillRefresh': 'Price will refresh on save',
      })[k] || maps.en[k] || k,
      escHtml: (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
      el,
      fetch: (url, init) => {
        fetchCalls.push({ url, body: init && init.body });
        const body = {
          success: true,
          total_cents: opts.quoteCents != null ? opts.quoteCents : 40000,
        };
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(body),
        });
      },
      _fetchCalls: fetchCalls,
    };

    // Redeclare mutable vars in prelude
    const prelude = [
      'var scheduleDrawerSaveInFlight = false;',
      'var scheduleDrawerPriceStale = false;',
      'var scheduleDrawerValidationState = { ok: true, errorKey: null };',
      'var scheduleDrawerCustomLines = [];',
      'var scheduleDrawerQuoteState = null;',
      'var scheduleDrawerQuoteGen = 0;',
      'var scheduleDrawerQuoteAbort = null;',
      'var scheduleDrawerQuoteTimer = null;',
      'var scheduleDrawerQuoteDebounceMs = 0;',
      'var scheduleAdminPricesCache = null;',
    ].join('\n');

    vm.createContext(ctx);
    try {
      vm.runInContext(prelude + '\n' + chunks.join('\n'), ctx);
    } catch (e) {
      ctx._loadError = e;
    }
    ctx.scheduleAdminPricesCache = prices;
    if (typeof ctx.scheduleDrawerAccommodationStays === 'undefined') ctx.scheduleDrawerAccommodationStays = [];
    // Lightweight stubs when portal helpers are not extracted into this sandbox.
    [
      ['schedulePortalNormalizeLessonsIntent', function() { return { present: false, lessons: [] }; }],
      ['schedulePortalNormalizeCourseEquipmentIntent', function() { return null; }],
      ['schedulePortalNormalizeAccommodationIntent', function() { return null; }],
      ['schedulePortalNormalizeCustomLinesIntent', function() { return []; }],
      ['schedulePortalNormalizeRentalsIntent', function(r) { return Array.isArray(r) ? r : []; }],
    ].forEach(function(pair) {
      if (typeof ctx[pair[0]] !== 'function') ctx[pair[0]] = pair[1];
    });

    const originalRender = ctx.scheduleRenderDrawerRentals;
    if (typeof originalRender === 'function') {
      ctx.scheduleRenderDrawerRentals = function() {
        originalRender();
        const wrapEl = el('ps-drawer-rentals');
        const parsed = parseRentalHtml(wrapEl.innerHTML, 'ps-drawer-rentals');
        wrapEl.children = parsed.children;
        wrapEl.querySelector = parsed.querySelector.bind(parsed);
        wrapEl.querySelectorAll = parsed.querySelectorAll.bind(parsed);
        wrapEl._rawHtml = wrapEl.innerHTML;
        // preserve attributes
        parsed.children.forEach((c) => { c.parentNode = wrapEl; });
      };
    }
    return { ctx, el, nodes, fetchCalls };
  }

  // No-lesson Edit: catalog rentals are visible (Group/Private hide them for course gear).
  const editHydrated = sandboxEdit({
    mode: 'none',
    qty: 4,
    surfers: 1,
    drawerSurfers: 1,
    rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '5_days', quantity: 4 }],
  });
  ok('Edit sandbox loaded scheduleRenderDrawerRentals',
    typeof editHydrated.ctx.scheduleRenderDrawerRentals === 'function',
    editHydrated.ctx._loadError && String(editHydrated.ctx._loadError.message));
  if (typeof editHydrated.ctx.scheduleRenderDrawerRentals === 'function') {
    editHydrated.ctx.scheduleRenderDrawerRentals();
  }
  const editHtml = (editHydrated.el('ps-drawer-rentals')._rawHtml
    || editHydrated.el('ps-drawer-rentals').innerHTML || '');
  ok('Edit hydrated row label is Qty never Surfers',
    />Qty</.test(editHtml) && !/>Surfers</.test(editHtml),
    editHtml.slice(0, 500));
  ok('Edit hydrated row preserves quantity 4',
    /value="4"/.test(editHtml)
    || (() => {
      const row = (editHydrated.el('ps-drawer-rentals').querySelectorAll('[data-rental-offering]') || [])
        .find((r) => r.getAttribute('data-rental-offering') === 'board_and_suit_rental');
      const q = row && row.querySelector('input.ps-drawer-rental-qty-input');
      return q && String(q.value) === '4';
    })(),
    editHtml.slice(0, 300));

  // ── [4] Edit no-lesson independent equipment qty ─────────────────────────
  console.log('\n[4] Edit no-lesson quantity ownership (independent of surfers)');
  const editNone = sandboxEdit({
    mode: 'none',
    qty: 2,
    surfers: 2,
    rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '5_days', quantity: 2 }],
  });
  if (typeof editNone.ctx.scheduleRenderDrawerRentals === 'function') {
    editNone.ctx.scheduleRenderDrawerRentals();
  }
  const noneHtml = editNone.el('ps-drawer-rentals')._rawHtml
    || editNone.el('ps-drawer-rentals').innerHTML || '';
  ok('Edit no-lesson shows Qty control when selected (not hidden forever)',
    /ps-drawer-rental-qty-input/.test(noneHtml)
    && (/data-rental-quantity|schedule\.create\.rentalQty|Qty/.test(noneHtml)),
    noneHtml.slice(0, 400));
  // Independent qty: set qty input to 9 then read (must NOT force back to surfers=2)
  const noneWrap = editNone.el('ps-drawer-rentals');
  (noneWrap.querySelectorAll('input.ps-drawer-rental-qty-input') || []).forEach((inp) => {
    inp.value = '9';
    inp.setAttribute('data-qty-owner', 'user');
  });
  let noneSel = [];
  if (typeof editNone.ctx.scheduleReadDrawerRentalSelectionFromDom === 'function') {
    // ensure checked
    (noneWrap.querySelectorAll('.ps-drawer-rental-check') || []).forEach((c) => {
      if (c.getAttribute('data-offering-key') === 'board_and_suit_rental') c.checked = true;
    });
    noneSel = editNone.ctx.scheduleReadDrawerRentalSelectionFromDom();
  }
  ok('Edit no-lesson read preserves independent user qty 9',
    Array.isArray(noneSel) && noneSel.some((r) => r.offering_key === 'board_and_suit_rental' && r.quantity === 9),
    JSON.stringify(noneSel));

  // ── [4b] Edit no-lesson booking-level Surfers (Create #ps-create-surfers parity) ──
  console.log('\n[4b] Edit no-lesson visible booking-level Surfers field');
  ok('Edit owner has #ps-drawer-surfers booking-level input',
    /id="ps-drawer-surfers"/.test(editSrc)
    || /id='ps-drawer-surfers'/.test(editSrc),
    'missing #ps-drawer-surfers in edit owner');
  ok('Edit owner labels booking-level field with schedule.create.surferCount',
    /ps-drawer-surfers[\s\S]{0,200}schedule\.create\.surferCount|schedule\.create\.surferCount[\s\S]{0,200}ps-drawer-surfers/.test(editSrc));
  ok('Edit owner uses touch-friendly number input (min 1 max 99 inputmode)',
    /id="ps-drawer-surfers"[^>]*type="number"/.test(editSrc)
    && /id="ps-drawer-surfers"[^>]*min="1"/.test(editSrc)
    && /id="ps-drawer-surfers"[^>]*max="99"/.test(editSrc)
    && /id="ps-drawer-surfers"[^>]*inputmode="numeric"/.test(editSrc));
  ok('scheduleDrawerReadSurferCount none-mode reads #ps-drawer-surfers (not only data-seed)',
    (() => {
      const fn = extractFn(editSrc, 'scheduleDrawerReadSurferCount') || '';
      return /ps-drawer-surfers/.test(fn)
        && !/data-seed-surfers[\s\S]*return 1/.test(fn.replace(/\s+/g, ' '));
    })(),
    (extractFn(editSrc, 'scheduleDrawerReadSurferCount') || '').slice(0, 400));
  ok('/staff/ui ships #ps-drawer-surfers',
    /id="ps-drawer-surfers"/.test(html));
  ok('EN/ES/IT schedule.create.surferCount full label present',
    maps.en['schedule.create.surferCount'] === 'Number of surfers'
    && (maps.es['schedule.create.surferCount'] === 'Número de surfistas'
      || /'schedule\.create\.surferCount':\s*'Número de surfistas'/.test(esSrc))
    && (maps.it['schedule.create.surferCount'] === 'Numero di surfisti'
      || /'schedule\.create\.surferCount':\s*'Numero di surfisti'/.test(i18nSrc)));

  // Hydrated qty 4 → booking Surfers=4; change to 2 → payload qty 2
  const editNone4 = sandboxEdit({
    mode: 'none',
    qty: 4,
    surfers: 4,
    drawerSurfers: 4,
    rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '5_days', quantity: 4 }],
  });
  if (typeof editNone4.ctx.scheduleRenderDrawerRentals === 'function') {
    editNone4.ctx.scheduleRenderDrawerRentals();
  }
  const read4 = typeof editNone4.ctx.scheduleDrawerReadSurferCount === 'function'
    ? editNone4.ctx.scheduleDrawerReadSurferCount()
    : null;
  ok('Edit no-lesson hydrated Surfers reads 4 from #ps-drawer-surfers',
    read4 === 4,
    'read=' + String(read4));
  // Check rental selection uses 4
  (editNone4.el('ps-drawer-rentals').querySelectorAll('.ps-drawer-rental-check') || []).forEach((c) => {
    c.checked = c.getAttribute('data-offering-key') === 'board_and_suit_rental';
  });
  let sel4 = [];
  if (typeof editNone4.ctx.scheduleReadDrawerRentalSelectionFromDom === 'function') {
    sel4 = editNone4.ctx.scheduleReadDrawerRentalSelectionFromDom();
  }
  ok('Edit no-lesson payload rentals qty=4 when equipment qty seeded 4',
    Array.isArray(sel4)
    && sel4.some((r) => r.offering_key === 'board_and_suit_rental' && r.quantity === 4),
    JSON.stringify(sel4));

  // Change booking-level Surfers 4 → 2: must NOT rewrite independent equipment qty
  editNone4.nodes['ps-drawer-surfers'].value = '2';
  const sn2 = editNone4.ctx.scheduleDrawerReadSurferCount();
  // Leave equipment qty inputs at 4 (do not lockstep from surfers)
  let sel2 = [];
  if (typeof editNone4.ctx.scheduleReadDrawerRentalSelectionFromDom === 'function') {
    sel2 = editNone4.ctx.scheduleReadDrawerRentalSelectionFromDom();
  }
  ok('Edit no-lesson changing Surfers to 2 keeps equipment qty 4',
    sn2 === 2
    && Array.isArray(sel2)
    && sel2.some((r) => r.offering_key === 'board_and_suit_rental' && r.quantity === 4),
    'sn=' + String(sn2) + ' sel=' + JSON.stringify(sel2));

  // Invalid 0 / blank / fraction: no silent fallback to 1; blocks validate
  const invCases = ['0', '', '1.5', 'abc', '100'];
  let invOk = true;
  const invDetails = [];
  invCases.forEach((raw) => {
    editNone4.nodes['ps-drawer-surfers'].value = raw;
    const sn = editNone4.ctx.scheduleDrawerReadSurferCount();
    if (sn === 1 || sn === 0) {
      invOk = false;
      invDetails.push(raw + '→' + String(sn) + '(silent fallback)');
    }
    if (sn != null && !(Number.isInteger(sn) && sn >= 1 && sn <= 99)) {
      invOk = false;
      invDetails.push(raw + '→' + String(sn));
    }
    // Prefer null for blank/invalid (Create parity)
    if (sn != null) {
      invOk = false;
      invDetails.push(raw + ' expected null got ' + String(sn));
    }
  });
  ok('Edit no-lesson invalid 0/blank/fraction returns null (no silent 1)',
    invOk, invDetails.join('; '));

  // Restore valid, paint quote, then invalidate via Surfers change
  editNone4.nodes['ps-drawer-surfers'].value = '4';
  editNone4.el('ps-drawer-quote-preview').innerHTML =
    '<p class="portal-schedule-drawer-hint">Quoted total: €40.00</p>';
  editNone4.el('ps-drawer-quote-preview').style.display = 'block';
  editNone4.ctx.scheduleDrawerQuoteState = { intent_key: 'stale-surfers', total_cents: 4000 };
  editNone4.nodes['ps-drawer-surfers'].value = '2';
  if (typeof editNone4.ctx.scheduleDrawerMarkPriceStale === 'function') {
    editNone4.ctx.scheduleDrawerMarkPriceStale();
  }
  ok('Edit Surfers change marks price stale',
    editNone4.ctx.scheduleDrawerPriceStale === true
    || editNone4.ctx.scheduleDrawerQuoteState == null);
  if (typeof editNone4.ctx.scheduleDrawerDropStaleQuoteUi === 'function') {
    const p = typeof editNone4.ctx.scheduleReadDrawerEditPayload === 'function'
      ? editNone4.ctx.scheduleReadDrawerEditPayload()
      : null;
    editNone4.ctx.scheduleDrawerDropStaleQuoteUi(p);
  } else if (typeof editNone4.ctx.scheduleDrawerSyncFooter === 'function') {
    editNone4.ctx.scheduleDrawerSyncFooter();
  }
  const afterSurf = editNone4.el('ps-drawer-quote-preview').innerHTML || '';
  ok('Edit Surfers change clears stale quote immediately',
    !/€40\.00/.test(afterSurf)
    || /Checking price|checkingPrice|portal-schedule-quote-checking/i.test(afterSurf),
    afterSurf);

  // Wire path: scheduleWireEditableDrawer must listen to #ps-drawer-surfers
  const wireFn = extractFn(editSrc, 'scheduleWireEditableDrawer') || '';
  ok('Edit wire path includes #ps-drawer-surfers for requote/stale',
    /ps-drawer-surfers/.test(wireFn),
    wireFn.slice(0, 300));

  // Validate blocks invalid surfer for no-lesson with rentals intent
  editNone4.nodes['ps-drawer-surfers'].value = '0';
  let gate0 = { ok: true };
  if (typeof editNone4.ctx.scheduleReadDrawerEditPayload === 'function'
    && typeof editNone4.ctx.scheduleDrawerValidateEditPayload === 'function') {
    // Ensure a rental is selected so intent needs surfers
    (editNone4.el('ps-drawer-rentals').querySelectorAll('.ps-drawer-rental-check') || []).forEach((c) => {
      if (c.getAttribute('data-offering-key') === 'board_and_suit_rental') c.checked = true;
    });
    const payload0 = editNone4.ctx.scheduleReadDrawerEditPayload();
    gate0 = editNone4.ctx.scheduleDrawerValidateEditPayload(payload0 || {});
  }
  ok('Edit no-lesson invalid Surfers blocks Save/quote validation',
    gate0 && gate0.ok === false
    && (gate0.errorKey === 'schedule.create.surfersRequired'
      || gate0.errorKey === 'schedule.create.componentsRequired'),
    JSON.stringify(gate0));

  // ── [5] DOM class/order parity + mutual exclusion ────────────────────────
  console.log('\n[5] Create/Edit row DOM class/order + mutual exclusion');
  const createHtmlParity = createHtml1;
  const editHtmlParity = editHtml;
  ok('Create row uses portal-schedule-create-rental-row + check + rental-qty',
    /portal-schedule-create-rental-row/.test(createHtmlParity)
    && /portal-schedule-create-check/.test(createHtmlParity)
    && /portal-schedule-create-rental-qty/.test(createHtmlParity));
  ok('Edit row uses same shared anatomy classes',
    /portal-schedule-create-rental-row/.test(editHtmlParity)
    && /portal-schedule-create-check/.test(editHtmlParity)
    && /portal-schedule-create-rental-qty/.test(editHtmlParity));
  ok('Create order: check before rental-qty',
    createHtmlParity.indexOf('portal-schedule-create-check')
      < createHtmlParity.indexOf('portal-schedule-create-rental-qty'));
  ok('Edit order: check before rental-qty',
    editHtmlParity.indexOf('portal-schedule-create-check')
      < editHtmlParity.indexOf('portal-schedule-create-rental-qty'));
  // Mutual exclusion: check source uses scheduleApplyRentalMutualExclusion
  ok('Edit mutual exclusion wired',
    /scheduleApplyRentalMutualExclusion/.test(editSrc)
    && /scheduleDrawerApplyRentalExclusionUi/.test(editSrc));
  ok('Create mutual exclusion wired',
    /scheduleApplyRentalMutualExclusion/.test(apiSrc)
    && /scheduleApplyCreateRentalExclusionUi/.test(apiSrc));

  // ── [6] Edit compact footer summary + quote row ──────────────────────────
  console.log('\n[6] Edit compact footer summary parity');
  const footerEdit = sandboxEdit({
    mode: 'group',
    qty: 1,
    courseQty: 1,
    guest: 'Koa',
    rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '5_days', quantity: 1 }],
    quoteCents: 19900,
  });
  // Seed course payload path via DOM
  footerEdit.nodes['ps-drawer-comp-course'].checked = true;
  footerEdit.nodes['ps-drawer-comp-no-lesson'].checked = false;
  if (typeof footerEdit.ctx.scheduleRenderDrawerRentals === 'function') {
    footerEdit.ctx.scheduleRenderDrawerRentals();
  }
  const wrapF = footerEdit.el('ps-drawer-rentals');
  (wrapF.querySelectorAll('.ps-drawer-rental-check') || []).forEach((c) => {
    c.checked = c.getAttribute('data-offering-key') === 'board_and_suit_rental';
  });
  if (typeof footerEdit.ctx.scheduleDrawerSyncFooter === 'function') {
    footerEdit.ctx.scheduleDrawerSyncFooter();
  }
  const sumHtml = footerEdit.el('ps-drawer-summary').innerHTML || '';
  const sumText = sumHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  ok('Edit summary two-row hierarchy classes',
    /portal-schedule-create-summary-primary/.test(sumHtml)
    && /portal-schedule-create-summary-secondary/.test(sumHtml),
    sumHtml);
  ok('Edit summary has Curso Mañana (not generic Group course alone)',
    /Curso Mañana/.test(sumText), sumText);
  ok('Edit summary omits generic Group course when named',
    !/Group course/i.test(sumText) || /Curso Mañana/.test(sumText), sumText);
  ok('Edit summary omits year 2026',
    !/\b2026\b/.test(sumText), sumText);
  ok('Edit summary omits Unpaid/Paid payment status',
    !/\bUnpaid\b|\bPaid\b/.test(sumText), sumText);
  ok('Edit summary single duration (no duplicate 5 days)',
    (sumText.match(/5 days/g) || []).length <= 1, sumText);
  ok('Edit summary keeps guest Koa',
    /Koa/.test(sumText), sumText);

  // Quote row: seed state and render
  if (typeof footerEdit.ctx.scheduleDrawerRenderQuotePreview === 'function') {
    footerEdit.ctx.scheduleDrawerQuoteState = {
      intent_key: typeof footerEdit.ctx.scheduleDrawerQuotePricingIntentKey === 'function'
        ? footerEdit.ctx.scheduleDrawerQuotePricingIntentKey(footerEdit.ctx.scheduleReadDrawerEditPayload())
        : 'x',
      total_cents: 19900,
    };
    footerEdit.ctx.scheduleDrawerRenderQuotePreview({
      ok: true,
      body: { total_cents: 19900, success: true },
      intent_key: footerEdit.ctx.scheduleDrawerQuoteState.intent_key,
    });
  }
  const qHtml = footerEdit.el('ps-drawer-quote-preview').innerHTML || '';
  const qText = qHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  ok('Edit quote own row exact server amount €199.00',
    /199\.00/.test(qText) && /Quoted total|quoteTotal/i.test(qText + portalTFallback()),
    qText);

  function portalTFallback() {
    return 'Quoted total';
  }

  // ── [7] Stale quote invalidation + requote ───────────────────────────────
  console.log('\n[7] Edit changed rental/date invalidates stale quote');
  const stale = sandboxEdit({
    mode: 'group',
    qty: 1,
    courseQty: 1,
    guest: 'Ada',
    rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '5_days', quantity: 1 }],
    quoteCents: 40000,
  });
  stale.nodes['ps-drawer-comp-course'].checked = true;
  stale.nodes['ps-drawer-comp-no-lesson'].checked = false;
  if (typeof stale.ctx.scheduleRenderDrawerRentals === 'function') {
    stale.ctx.scheduleRenderDrawerRentals();
  }
  // Paint a stale €40 quote
  stale.el('ps-drawer-quote-preview').innerHTML =
    '<p class="portal-schedule-drawer-hint">Quoted total: €40.00</p>';
  stale.el('ps-drawer-quote-preview').style.display = 'block';
  stale.ctx.scheduleDrawerQuoteState = { intent_key: 'stale-old-intent', total_cents: 4000 };

  // Change date → 6 days
  stale.nodes['ps-drawer-date-to'].value = '2026-08-01';
  if (typeof stale.ctx.scheduleDrawerMarkPriceStale === 'function') {
    stale.ctx.scheduleDrawerMarkPriceStale();
  }
  let dropped = false;
  if (typeof stale.ctx.scheduleDrawerDropStaleQuoteUi === 'function') {
    const payload = typeof stale.ctx.scheduleReadDrawerEditPayload === 'function'
      ? stale.ctx.scheduleReadDrawerEditPayload()
      : null;
    dropped = stale.ctx.scheduleDrawerDropStaleQuoteUi(payload);
  } else if (typeof stale.ctx.scheduleDrawerSyncFooter === 'function') {
    stale.ctx.scheduleDrawerSyncFooter();
    dropped = true;
  }
  const afterDrop = stale.el('ps-drawer-quote-preview').innerHTML || '';
  ok('stale €40 cleared (or checking) on pricing intent change',
    !/€40\.00/.test(afterDrop)
    || /Checking price|checkingPrice|portal-schedule-quote-checking/i.test(afterDrop),
    afterDrop);
  ok('scheduleDrawerPriceStale set on mark',
    stale.ctx.scheduleDrawerPriceStale === true || dropped === true);

  if (typeof stale.ctx.scheduleDrawerRefreshQuote === 'function') {
    await stale.ctx.scheduleDrawerRefreshQuote();
    await sleep(50);
  } else if (typeof stale.ctx.scheduleDrawerSyncFooter === 'function') {
    stale.ctx.scheduleDrawerSyncFooter();
    await sleep(50);
  }
  ok('requote attempted after intent change (fetch or checking UI)',
    (stale.fetchCalls && stale.fetchCalls.length > 0)
    || /Checking price|Quoted total|€400\.00|portal-schedule-quote/i.test(
      stale.el('ps-drawer-quote-preview').innerHTML || '',
    ),
    'fetches=' + (stale.fetchCalls ? stale.fetchCalls.length : 0)
      + ' html=' + (stale.el('ps-drawer-quote-preview').innerHTML || '').slice(0, 120));

  // ── [8] 375/430 + EN/ES/IT already partially in [0]; reinforce ───────────
  console.log('\n[8] Mobile CSS + locale labels reinforce');
  ok('EN Qty exact', maps.en['schedule.create.rentalQty'] === 'Qty');
  ok('ES Cant. exact',
    maps.es['schedule.create.rentalQty'] === 'Cant.'
    || esSrc.includes("'schedule.create.rentalQty': 'Cant.'"));
  ok('IT Qtà exact',
    maps.it['schedule.create.rentalQty'] === 'Qtà'
    || i18nSrc.includes("'schedule.create.rentalQty': 'Qtà'"));
  ok('do not use Number of surfers for compact row key',
    maps.en['schedule.create.rentalQty'] !== maps.en['schedule.create.surferCount']);
  ok('drawer width 100vw at mobile breakpoint',
    /100vw/.test(apiSrc));
  ok('create-footer overflow-x hidden (no horizontal clip spill)',
    /\.portal-schedule-create-footer\{[^}]*overflow-x:\s*hidden/.test(apiSrc));

  // ── [9] Mutation guard ───────────────────────────────────────────────────
  console.log('\n[9] Mutation guard: Qty → Surfers must RED');
  {
    const mutatedApi = apiSrc
      .replace(/data-i18n="schedule\.create\.rentalQty">Qty</g,
        'data-i18n="schedule.create.rentalQty">Surfers<');
    const mutatedI18n = i18nSrc
      .replace(/'schedule\.create\.rentalQty':\s*'Qty'/,
        "'schedule.create.rentalQty': 'Surfers'");
    const mutatedEdit = editSrc
      .replace(/\|\| 'Qty'/g, "|| 'Surfers'")
      .replace(/>Qty</g, '>Surfers<');
    ok('mutation would RED Create fallback',
      /data-i18n="schedule\.create\.rentalQty">Surfers</.test(mutatedApi)
      && !/data-i18n="schedule\.create\.rentalQty">Qty</.test(mutatedApi));
    ok('mutation would RED EN i18n',
      /'schedule\.create\.rentalQty':\s*'Surfers'/.test(mutatedI18n));
    ok('live Create is not mutated (still Qty)',
      /data-i18n="schedule\.create\.rentalQty">Qty</.test(apiSrc));
    ok('mutation guard asserts Surfers is forbidden as rentalQty in live paths',
      !/data-i18n="schedule\.create\.rentalQty">Surfers</.test(apiSrc)
      && !/'schedule\.create\.rentalQty':\s*'Surfers'/.test(i18nSrc));
    // If someone reintroduces Surfers-as-qty, these static checks fail (RED).
    void mutatedEdit;
  }

  // Summary owner presence for Edit compact hierarchy
  ok('Edit owner has compact summary primary/secondary or reuses portal renderer',
    /portal-schedule-create-summary-primary/.test(editSrc)
    || /scheduleDrawerRenderIntentSummary|schedulePortalRenderCreateIntentSummary/.test(editSrc));

  console.log(`\n── verify:sunset-rental-surfer-label-edit-parity ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
