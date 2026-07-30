'use strict';

/**
 * verify:sunset-rental-quantity-create-edit
 *
 * Vertical-slice contract for independent rental equipment quantity on
 * Create + Edit, data-driven hour/day pricing, and day-discount continuation.
 *
 * Exercises pure owners + rendered Staff API Create/Edit paths (not only
 * template regex). No DB/cloud/live mutation.
 *
 * Run: node scripts/verify-sunset-rental-quantity-create-edit.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const {
  prepareGenericRentalsForCreate,
  buildGenericRentalAuthoritativeQuote,
  applyNoLessonEquipmentQtyFromSurfers,
} = require('./lib/sunset-schedule-booking-writes');
const {
  resolveGenericRentalPrice,
  resolveDayRentalContinuation,
} = require('./lib/tenant-rental-price-resolver');
const { formatServiceRecordInvoiceLineText } = require('./lib/service-record-invoice-line');
const rentalAvail = require('./browser/sunset-schedule-rental-availability');

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    fail += 1;
  }
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
    req.setTimeout(20000, () => req.destroy(new Error('GET timeout')));
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
    for (let i = 0; i < 50; i += 1) {
      if (child.exitCode != null) {
        throw new Error('staff-query-api exited early: ' + stderr.slice(0, 400));
      }
      try {
        const res = await httpGet('http://127.0.0.1:' + port + '/staff/ui');
        if (res.status === 200 && res.body.includes('<!DOCTYPE html>')) {
          return { html: res.body, kill: () => { try { child.kill('SIGTERM'); } catch (_e) { /* */ } } };
        }
        lastErr = new Error('HTTP ' + res.status);
      } catch (e) {
        lastErr = e;
      }
      await sleep(120);
    }
    throw lastErr || new Error('timeout waiting for /staff/ui');
  } catch (err) {
    try { child.kill('SIGKILL'); } catch (_k) { /* */ }
    throw err;
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

/** Minimal DOM for Create/Edit rental qty stepper + serialize path. */
function miniDom() {
  function El(attrs) {
    this.attrs = Object.assign({}, attrs || {});
    this.children = [];
    this.value = attrs && attrs.value != null ? String(attrs.value) : '';
    this._checked = attrs && (attrs.checked === true || attrs.checked === '');
    this.disabled = !!(attrs && attrs.disabled);
    this.style = {};
    this.dataset = {};
    this._html = '';
    this.textContent = '';
    this.className = (attrs && attrs.class) || '';
    this._listeners = {};
    this.tagName = String((attrs && attrs.tag) || 'DIV').toUpperCase();
    this.type = (attrs && attrs.type) || '';
    this.min = attrs && attrs.min != null ? String(attrs.min) : '';
    this.max = attrs && attrs.max != null ? String(attrs.max) : '';
    this.id = (attrs && attrs.id) || '';
    const self = this;
    this.classList = {
      add(c) {
        const parts = String(self.className || '').split(/\s+/).filter(Boolean);
        if (parts.indexOf(c) < 0) parts.push(c);
        self.className = parts.join(' ');
        self.attrs.class = self.className;
      },
      remove(c) {
        const parts = String(self.className || '').split(/\s+/).filter(Boolean)
          .filter((x) => x !== c);
        self.className = parts.join(' ');
        self.attrs.class = self.className;
      },
      contains(c) {
        return String(self.className || '').split(/\s+/).indexOf(c) >= 0;
      },
      toggle(c, force) {
        if (force === true) this.add(c);
        else if (force === false) this.remove(c);
        else if (this.contains(c)) this.remove(c);
        else this.add(c);
      },
    };
  }
  Object.defineProperty(El.prototype, 'checked', {
    get() { return this._checked; },
    set(v) { this._checked = !!v; },
  });
  El.prototype.getAttribute = function getAttribute(k) {
    if (k === 'class') return this.className;
    if (Object.prototype.hasOwnProperty.call(this.attrs, k)) return String(this.attrs[k]);
    if (k === 'data-qty-owner' && this.dataset.qtyOwner != null) return this.dataset.qtyOwner;
    if (k && k.indexOf('data-') === 0) {
      const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (this.dataset[camel] != null) return String(this.dataset[camel]);
    }
    return null;
  };
  El.prototype.setAttribute = function setAttribute(k, v) {
    this.attrs[k] = v;
    if (k === 'class') this.className = String(v);
    if (k === 'value') this.value = String(v);
    if (k === 'min') this.min = String(v);
    if (k === 'max') this.max = String(v);
    if (k === 'data-qty-owner') this.dataset.qtyOwner = String(v);
    if (k && k.indexOf('data-') === 0) {
      const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[camel] = String(v);
    }
  };
  El.prototype.removeAttribute = function removeAttribute(k) {
    delete this.attrs[k];
    if (k === 'hidden') { /* */ }
  };
  El.prototype.appendChild = function appendChild(c) {
    this.children.push(c);
    c.parentNode = this;
    return c;
  };
  El.prototype.insertBefore = function insertBefore(node, ref) {
    const i = this.children.indexOf(ref);
    if (i < 0) this.children.push(node);
    else this.children.splice(i, 0, node);
    node.parentNode = this;
    return node;
  };
  El.prototype.querySelector = function querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  };
  El.prototype.querySelectorAll = function querySelectorAll(sel) {
    const out = [];
    const walk = (n) => {
      if (!n) return;
      if (matchSel(n, sel)) out.push(n);
      (n.children || []).forEach(walk);
    };
    (this.children || []).forEach(walk);
    return out;
  };
  El.prototype.closest = function closest(sel) {
    let n = this;
    while (n) {
      if (matchSel(n, sel)) return n;
      n = n.parentNode;
    }
    return null;
  };
  El.prototype.addEventListener = function addEventListener(type, fn) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(fn);
  };
  El.prototype.dispatchEvent = function dispatchEvent(ev) {
    const type = ev && ev.type;
    const list = (this._listeners[type] || []).slice();
    list.forEach((fn) => fn(ev || { type, target: this, bubbles: true }));
    if (ev && ev.bubbles && this.parentNode && this.parentNode.dispatchEvent) {
      this.parentNode.dispatchEvent(ev);
    }
    return true;
  };
  El.prototype.click = function click() {
    this.dispatchEvent({ type: 'click', target: this, preventDefault() {}, bubbles: true });
  };
  Object.defineProperty(El.prototype, 'innerHTML', {
    get() { return this._html; },
    set(v) {
      this._html = String(v);
      this.children = parseSimpleHtml(String(v), this);
    },
  });

  function matchSel(n, sel) {
    if (!n || !sel) return false;
    const s = String(sel).trim();
    if (s.charAt(0) === '.') {
      return n.classList && n.classList.contains(s.slice(1));
    }
    if (s.charAt(0) === '#') return n.id === s.slice(1);
    if (s.indexOf('[') === 0) {
      const m = s.match(/^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/);
      if (!m) return false;
      const val = n.getAttribute(m[1]);
      if (m[2] == null) return val != null;
      return val === m[2];
    }
    if (s.indexOf('.') > 0) {
      const [tag, cls] = s.split('.');
      return n.tagName === tag.toUpperCase() && n.classList.contains(cls);
    }
    if (/^[a-z]+$/i.test(s)) return n.tagName === s.toUpperCase();
    // compound: input.ps-create-rental-qty-input
    if (s.includes('.')) {
      const parts = s.split('.');
      if (n.tagName !== parts[0].toUpperCase()) return false;
      return parts.slice(1).every((c) => n.classList.contains(c));
    }
    if (s.includes('[')) {
      const tag = s.slice(0, s.indexOf('['));
      const rest = s.slice(s.indexOf('['));
      if (tag && n.tagName !== tag.toUpperCase()) return false;
      return matchSel(n, rest);
    }
    return false;
  }

  function parseSimpleHtml(html, parent) {
    // Enough for rental row fragments used in this gate.
    const nodes = [];
    const re = /<([a-z0-9-]+)([^>]*)>([\s\S]*?)<\/\1>|<([a-z0-9-]+)([^>]*)\/?>/gi;
    let m;
    const src = html;
    // Very small recursive-ish parser for our controlled fragments.
    const openRe = /<([a-z0-9-]+)([^>]*)>/gi;
    // Fallback: attribute harvest only for qty inputs / checks / rows.
    const rowRe = /data-rental-offering="([^"]+)"/g;
    // Use a cheap DOM: create elements from known patterns via regex builders.
    return buildFromHtml(html, parent);
  }

  function attrsFrom(str) {
    const a = {};
    const re = /([a-zA-Z0-9_:-]+)(?:=["']([^"']*)["'])?/g;
    let m;
    while ((m = re.exec(str || ''))) {
      a[m[1]] = m[2] != null ? m[2] : '';
    }
    return a;
  }

  function buildFromHtml(html, parent) {
    const kids = [];
    // Split top-level tags crudely.
    const tagRe = /<([a-z0-9-]+)([^>]*)>([\s\S]*?)<\/\1>|<([a-z0-9-]+)([^>]*)\/>/gi;
    let m;
    let guard = 0;
    const work = String(html);
    // If nested, handle div.portal-schedule-create-rental-row specially.
    const rowParts = work.split(/(?=<div class="portal-schedule-create-rental-row)/);
    if (rowParts.length > 1 || /portal-schedule-create-rental-row/.test(work)) {
      const rows = work.match(/<div class="portal-schedule-create-rental-row[\s\S]*?<\/div>\s*(?=<div class="portal-schedule-create-rental-row|$)/g)
        || [work];
      rows.forEach((chunk) => {
        if (!chunk.trim()) return;
        const rowAttrs = attrsFrom((chunk.match(/^<div([^>]*)>/) || [])[1] || '');
        const row = new El(Object.assign({ tag: 'div', class: rowAttrs.class || 'portal-schedule-create-rental-row' }, rowAttrs));
        if (rowAttrs['data-rental-offering']) {
          row.setAttribute('data-rental-offering', rowAttrs['data-rental-offering']);
        }
        if (rowAttrs['data-rental-duration-key']) {
          row.setAttribute('data-rental-duration-key', rowAttrs['data-rental-duration-key']);
        }
        // checkbox
        const checkM = chunk.match(/<input([^>]*class="[^"]*ps-(?:create|drawer)-rental-check[^"]*"[^>]*)>/i)
          || chunk.match(/<input([^>]*ps-(?:create|drawer)-rental-check[^>]*)>/i);
        if (checkM) {
          const ca = attrsFrom(checkM[1]);
          const check = new El(Object.assign({ tag: 'input', type: 'checkbox', class: ca.class || 'ps-create-rental-check' }, ca));
          if (ca.checked != null) check.checked = true;
          row.appendChild(check);
        }
        // qty input
        const qtyM = chunk.match(/<input([^>]*ps-(?:create|drawer)-rental-qty-input[^>]*)>/i);
        if (qtyM) {
          const qa = attrsFrom(qtyM[1]);
          const qtyWrap = new El({ tag: 'div', class: 'portal-schedule-create-rental-qty' });
          const qty = new El(Object.assign({
            tag: 'input',
            type: 'number',
            class: qa.class || 'ps-create-rental-qty-input',
            min: qa.min || '1',
            max: qa.max || '99',
            value: qa.value || '1',
          }, qa));
          qty.value = String(qa.value != null ? qa.value : '1');
          if (qa['data-qty-owner']) qty.setAttribute('data-qty-owner', qa['data-qty-owner']);
          if (qa['data-rental-quantity'] != null || /data-rental-quantity/.test(qtyM[1])) {
            qty.setAttribute('data-rental-quantity', qa['data-rental-quantity'] || '');
          }
          qtyWrap.appendChild(qty);
          row.appendChild(qtyWrap);
        }
        // duration select
        const selM = chunk.match(/<select([^>]*ps-(?:create|drawer)-rental-duration[^>]*)>([\s\S]*?)<\/select>/i);
        if (selM) {
          const sa = attrsFrom(selM[1]);
          const sel = new El(Object.assign({ tag: 'select', class: sa.class || 'ps-create-rental-duration' }, sa));
          const optRe = /<option([^>]*)>([\s\S]*?)<\/option>/gi;
          let om;
          while ((om = optRe.exec(selM[2]))) {
            const oa = attrsFrom(om[1]);
            const opt = new El(Object.assign({ tag: 'option' }, oa));
            opt.value = oa.value || '';
            opt.textContent = om[2];
            if (oa.selected != null) sel.value = opt.value;
            sel.appendChild(opt);
          }
          if (!sel.value && sel.children[0]) sel.value = sel.children[0].value;
          row.appendChild(sel);
        }
        kids.push(row);
        row.parentNode = parent;
      });
      return kids;
    }
    while ((m = tagRe.exec(work)) && guard < 50) {
      guard += 1;
      const tag = m[1] || m[4];
      const attrStr = m[2] || m[5] || '';
      const inner = m[3] || '';
      const a = attrsFrom(attrStr);
      const el = new El(Object.assign({ tag }, a));
      if (inner) {
        el.children = buildFromHtml(inner, el);
        el.children.forEach((c) => { c.parentNode = el; });
      }
      el.parentNode = parent;
      kids.push(el);
    }
    return kids;
  }

  function documentCreate(tag) {
    return new El({ tag });
  }

  return { El, documentCreate, matchSel };
}

function makeLoadRule(table) {
  const calls = [];
  const fn = async (params) => {
    const itemCode = `${params.itemCode}__${params.duration}`;
    calls.push(params.duration);
    const row = table[`${itemCode}|${params.billingUnit}|${params.locationId}`]
      || table[`${itemCode}|${params.locationId}`]
      || table[itemCode];
    if (!row) return { status: 'not_found' };
    return {
      status: 'found',
      item_code: itemCode,
      unit: params.billingUnit,
      location_id: params.locationId,
      amount_cents: row.amount_cents,
      currency: row.currency || 'EUR',
    };
  };
  fn.calls = () => calls.slice();
  return fn;
}

async function main() {
  console.log('\nverify:sunset-rental-quantity-create-edit\n');

  // ── 0) Pure day-continuation owner ───────────────────────────────────────
  console.log('[0] Day-tier continuation pure math (contract example)');
  ok('resolveDayRentalContinuation exported',
    typeof resolveDayRentalContinuation === 'function',
    'missing resolveDayRentalContinuation — implement pure day continuation owner');

  if (typeof resolveDayRentalContinuation === 'function') {
    const tiers = [
      { days: 1, amount_cents: 2000 },
      { days: 3, amount_cents: 5400 },
      { days: 7, amount_cents: 10500 },
    ];
    const cases = [
      { n: 2, expect: 4000, mode: 'continued', base: 1 },
      { n: 3, expect: 5400, mode: 'exact', base: 3 },
      { n: 5, expect: 9000, mode: 'continued', base: 3 },
      { n: 7, expect: 10500, mode: 'exact', base: 7 },
      { n: 9, expect: 13500, mode: 'continued', base: 7 },
    ];
    for (const c of cases) {
      const got = resolveDayRentalContinuation({
        requestedDays: c.n,
        tiers,
        quantity: 1,
      });
      ok(`${c.n}d → €${(c.expect / 100).toFixed(0)} (${c.mode})`,
        got && got.ok === true
          && got.amount_cents === c.expect
          && got.pricing_mode === (c.mode === 'exact' ? 'exact_duration_package' : 'continued_day_discount')
          && got.base_days === c.base,
        JSON.stringify(got));
    }
    // qty × duration; never guest count
    const q4 = resolveDayRentalContinuation({
      requestedDays: 5, tiers, quantity: 4,
    });
    ok('5d × qty 4 = 36000 (not guest-multiplied)',
      q4 && q4.ok && q4.amount_cents === 36000 && q4.quantity === 4,
      JSON.stringify(q4));

    // Non-divisible tier: Math.round convention (course path parity)
    const uneven = resolveDayRentalContinuation({
      requestedDays: 5,
      tiers: [{ days: 3, amount_cents: 5500 }],
      quantity: 1,
    });
    ok('non-divisible tier uses Math.round(tier*N/M)',
      uneven && uneven.ok && uneven.amount_cents === Math.round(5500 * 5 / 3),
      JSON.stringify(uneven));
  }

  // ── 1) Server create: multi-day continuation + qty ────────────────────────
  console.log('\n[1] prepareGenericRentalsForCreate — continuation + qty');
  process.env.GENERIC_RENTAL_CREATE_ENABLED = 'true';
  const catalog = [
    { offering_key: 'board_rental', label: 'Surfboard', active: true, location_id: 'sunset-somo', excludes: [] },
    { offering_key: 'wetsuit_rental', label: 'Wetsuit', active: true, location_id: 'sunset-somo', excludes: [] },
    { offering_key: 'kayak_rental', label: 'Sea Kayak', active: true, location_id: 'sunset-somo', excludes: [] },
  ];
  // Note: board/wetsuit are canonical — use kayak for generic lane continuation.
  const dayTable = {
    'kayak_rental__1_day|day|sunset-somo': { amount_cents: 2000 },
    'kayak_rental__3_days|day|sunset-somo': { amount_cents: 5400 },
    'kayak_rental__7_days|day|sunset-somo': { amount_cents: 10500 },
    'kayak_rental__4_hours|session|sunset-somo': { amount_cents: 3000 },
    'kayak_rental__2_hours|session|sunset-somo': { amount_cents: 1800 },
  };

  const cont5 = await prepareGenericRentalsForCreate({
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    serviceDate: '2026-08-01',
    pgClient: {},
    calendarDayCount: 5,
    bookingDurationKey: '5_days',
    rentals: [{ offering_key: 'kayak_rental', duration_key: '5_days', quantity: 1 }],
    listOfferings: async () => catalog,
    loadRule: makeLoadRule(dayTable),
    // Optional: list day tiers when implementer needs them without probing
    listDayTiers: async () => ([
      { days: 1, duration_key: '1_day', amount_cents: 2000 },
      { days: 3, duration_key: '3_days', amount_cents: 5400 },
      { days: 7, duration_key: '7_days', amount_cents: 10500 },
    ]),
  });
  ok('5-day span continues 3-day tier → €90',
    cont5.ok === true
      && cont5.records
      && cont5.records[0]
      && cont5.records[0].amount_due_cents === 9000
      && cont5.records[0].metadata
      && cont5.records[0].metadata.duration_key === '3_days'
      && cont5.records[0].metadata.selected_duration_key === '5_days'
      && cont5.records[0].metadata.booking_duration_key === '5_days',
    JSON.stringify(cont5));

  // qty×continuation with truthful span identity (not unconfigured 1_day when 3d owns base).
  const cont5q2 = await prepareGenericRentalsForCreate({
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    serviceDate: '2026-08-01',
    pgClient: {},
    calendarDayCount: 5,
    bookingDurationKey: '5_days',
    rentals: [{ offering_key: 'kayak_rental', duration_key: '5_days', quantity: 2 }],
    listOfferings: async () => catalog,
    loadRule: makeLoadRule(dayTable),
    listDayTiers: async () => ([
      { days: 1, duration_key: '1_day', amount_cents: 2000 },
      { days: 3, duration_key: '3_days', amount_cents: 5400 },
      { days: 7, duration_key: '7_days', amount_cents: 10500 },
    ]),
  });
  ok('5-day × qty2 continues 3d tier → €180 (not 1d×5×2 guest-style)',
    cont5q2.ok === true
      && cont5q2.records
      && cont5q2.records[0]
      && cont5q2.records[0].amount_due_cents === 18000
      && cont5q2.records[0].quantity === 2
      && cont5q2.records[0].metadata.duration_key === '3_days'
      && cont5q2.records[0].metadata.selected_duration_key === '5_days',
    JSON.stringify(cont5q2));

  const exact3 = await prepareGenericRentalsForCreate({
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    serviceDate: '2026-08-01',
    pgClient: {},
    calendarDayCount: 3,
    bookingDurationKey: '3_days',
    rentals: [{ offering_key: 'kayak_rental', duration_key: '3_days', quantity: 1 }],
    listOfferings: async () => catalog,
    loadRule: makeLoadRule(dayTable),
  });
  ok('exact 3_days wins €54',
    exact3.ok && exact3.records[0].amount_due_cents === 5400,
    JSON.stringify(exact3));

  const hourOk = await prepareGenericRentalsForCreate({
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    serviceDate: '2026-08-01',
    pgClient: {},
    calendarDayCount: 1,
    bookingDurationKey: '1_day',
    rentals: [{ offering_key: 'kayak_rental', duration_key: '4_hours', quantity: 3 }],
    listOfferings: async () => catalog,
    loadRule: makeLoadRule(dayTable),
  });
  ok('exact 4_hours × 3 = 9000 (no hour stacking)',
    hourOk.ok && hourOk.records[0].amount_due_cents === 9000
      && hourOk.records[0].metadata.duration_key === '4_hours',
    JSON.stringify(hourOk));

  const hourMissing = await prepareGenericRentalsForCreate({
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    serviceDate: '2026-08-01',
    pgClient: {},
    calendarDayCount: 1,
    bookingDurationKey: '1_day',
    rentals: [{ offering_key: 'kayak_rental', duration_key: '5_hours', quantity: 1 }],
    listOfferings: async () => catalog,
    loadRule: makeLoadRule(dayTable),
  });
  ok('unsupported 5_hours fails closed',
    hourMissing.ok === false,
    JSON.stringify(hourMissing));

  const hourMulti = await prepareGenericRentalsForCreate({
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    serviceDate: '2026-08-01',
    pgClient: {},
    calendarDayCount: 3,
    bookingDurationKey: '3_days',
    rentals: [{ offering_key: 'kayak_rental', duration_key: '4_hours', quantity: 1 }],
    listOfferings: async () => catalog,
    loadRule: makeLoadRule(dayTable),
  });
  ok('hour package on multi-day fails closed',
    hourMulti.ok === false && hourMulti.reason === 'rental_duration_not_compatible',
    JSON.stringify(hourMulti));

  // ── 1b) Hostile selected-duration + tier-probe fail-closed (independent review) ──
  console.log('\n[1b] Hostile: selected duration identity + tier-probe integrity');

  // BLOCKER 1: malformed / non-day selectedDuration must not receive continuation money.
  const bananaHostile = await prepareGenericRentalsForCreate({
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    serviceDate: '2026-08-01',
    pgClient: {},
    calendarDayCount: 5,
    bookingDurationKey: '5_days',
    rentals: [{ offering_key: 'kayak_rental', duration_key: 'banana', quantity: 1 }],
    listOfferings: async () => catalog,
    loadRule: makeLoadRule(dayTable),
    listDayTiers: async () => ([
      { days: 1, duration_key: '1_day', amount_cents: 2000 },
      { days: 3, duration_key: '3_days', amount_cents: 5400 },
    ]),
  });
  ok('banana selectedDuration fails closed (zero priced records)',
    bananaHostile.ok === false
      && bananaHostile.reason === 'rental_duration_not_compatible'
      && !Array.isArray(bananaHostile.records),
    JSON.stringify(bananaHostile));

  const unknownMalformed = await prepareGenericRentalsForCreate({
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    serviceDate: '2026-08-01',
    pgClient: {},
    calendarDayCount: 5,
    bookingDurationKey: '5_days',
    rentals: [{ offering_key: 'kayak_rental', duration_key: 'not_a_duration', quantity: 1 }],
    listOfferings: async () => catalog,
    loadRule: makeLoadRule(dayTable),
    listDayTiers: async () => ([
      { days: 1, duration_key: '1_day', amount_cents: 2000 },
      { days: 3, duration_key: '3_days', amount_cents: 5400 },
    ]),
  });
  ok('unknown malformed selectedDuration fails closed (zero priced records)',
    unknownMalformed.ok === false
      && unknownMalformed.reason === 'rental_duration_not_compatible'
      && !Array.isArray(unknownMalformed.records),
    JSON.stringify(unknownMalformed));

  // Contradictory: selected day identity longer than booking span (7d on 5d).
  const contradictSpan = await prepareGenericRentalsForCreate({
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    serviceDate: '2026-08-01',
    pgClient: {},
    calendarDayCount: 5,
    bookingDurationKey: '5_days',
    rentals: [{ offering_key: 'kayak_rental', duration_key: '7_days', quantity: 1 }],
    listOfferings: async () => catalog,
    loadRule: makeLoadRule(dayTable),
    listDayTiers: async () => ([
      { days: 1, duration_key: '1_day', amount_cents: 2000 },
      { days: 3, duration_key: '3_days', amount_cents: 5400 },
      { days: 7, duration_key: '7_days', amount_cents: 10500 },
    ]),
  });
  ok('contradictory 7_days on 5-day span fails closed (zero priced records)',
    contradictSpan.ok === false
      && contradictSpan.reason === 'rental_duration_not_compatible'
      && !Array.isArray(contradictSpan.records),
    JSON.stringify(contradictSpan));

  // BLOCKER A: parseable selected day ≤ span is insufficient when that identity
  // did not own the requested span or the authoritative base tier used for price.
  // Example: 5-day span, Admin tiers 1d+3d only, hostile selected 2_days → reject
  // (must never price from 3d while persisting selected_duration_key=2_days).
  const hostile2Days = await prepareGenericRentalsForCreate({
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    serviceDate: '2026-08-01',
    pgClient: {},
    calendarDayCount: 5,
    bookingDurationKey: '5_days',
    rentals: [{ offering_key: 'kayak_rental', duration_key: '2_days', quantity: 1 }],
    listOfferings: async () => catalog,
    loadRule: makeLoadRule({
      'kayak_rental__1_day|day|sunset-somo': { amount_cents: 2000 },
      'kayak_rental__3_days|day|sunset-somo': { amount_cents: 5400 },
    }),
    listDayTiers: async () => ([
      { days: 1, duration_key: '1_day', amount_cents: 2000 },
      { days: 3, duration_key: '3_days', amount_cents: 5400 },
    ]),
  });
  ok('hostile selected 2_days with configured 1d+3d rejects (zero priced records)',
    hostile2Days.ok === false
      && hostile2Days.reason === 'rental_duration_not_compatible'
      && !Array.isArray(hostile2Days.records),
    JSON.stringify(hostile2Days));

  // Positive: selected span identity 5_days → truthful 3d continuation + metadata.
  const sel5Truth = await prepareGenericRentalsForCreate({
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    serviceDate: '2026-08-01',
    pgClient: {},
    calendarDayCount: 5,
    bookingDurationKey: '5_days',
    rentals: [{ offering_key: 'kayak_rental', duration_key: '5_days', quantity: 1 }],
    listOfferings: async () => catalog,
    loadRule: makeLoadRule({
      'kayak_rental__1_day|day|sunset-somo': { amount_cents: 2000 },
      'kayak_rental__3_days|day|sunset-somo': { amount_cents: 5400 },
    }),
    listDayTiers: async () => ([
      { days: 1, duration_key: '1_day', amount_cents: 2000 },
      { days: 3, duration_key: '3_days', amount_cents: 5400 },
    ]),
  });
  ok('selected 5_days → same truthful 3d continuation; selected/base metadata no conflict',
    sel5Truth.ok === true
      && sel5Truth.records
      && sel5Truth.records[0]
      && sel5Truth.records[0].amount_due_cents === 9000
      && sel5Truth.records[0].metadata.duration_key === '3_days'
      && sel5Truth.records[0].metadata.selected_duration_key === '5_days'
      && sel5Truth.records[0].metadata.booking_duration_key === '5_days'
      && sel5Truth.records[0].metadata.selected_duration_key !== '2_days',
    JSON.stringify(sel5Truth));

  // Positive: selected actual base tier 3_days → same money; selected owns base identity.
  const sel3Truth = await prepareGenericRentalsForCreate({
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    serviceDate: '2026-08-01',
    pgClient: {},
    calendarDayCount: 5,
    bookingDurationKey: '5_days',
    rentals: [{ offering_key: 'kayak_rental', duration_key: '3_days', quantity: 1 }],
    listOfferings: async () => catalog,
    loadRule: makeLoadRule({
      'kayak_rental__1_day|day|sunset-somo': { amount_cents: 2000 },
      'kayak_rental__3_days|day|sunset-somo': { amount_cents: 5400 },
    }),
    listDayTiers: async () => ([
      { days: 1, duration_key: '1_day', amount_cents: 2000 },
      { days: 3, duration_key: '3_days', amount_cents: 5400 },
    ]),
  });
  ok('selected 3_days → same truthful 3d continuation; selected matches base',
    sel3Truth.ok === true
      && sel3Truth.records
      && sel3Truth.records[0]
      && sel3Truth.records[0].amount_due_cents === 9000
      && sel3Truth.records[0].metadata.duration_key === '3_days'
      && sel3Truth.records[0].metadata.selected_duration_key === '3_days'
      && sel3Truth.records[0].metadata.booking_duration_key === '5_days',
    JSON.stringify(sel3Truth));

  // 1_day is only legal when it is the actual continuation base (not when 3d owns base).
  const sel1When3Base = await prepareGenericRentalsForCreate({
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    serviceDate: '2026-08-01',
    pgClient: {},
    calendarDayCount: 5,
    bookingDurationKey: '5_days',
    rentals: [{ offering_key: 'kayak_rental', duration_key: '1_day', quantity: 1 }],
    listOfferings: async () => catalog,
    loadRule: makeLoadRule({
      'kayak_rental__1_day|day|sunset-somo': { amount_cents: 2000 },
      'kayak_rental__3_days|day|sunset-somo': { amount_cents: 5400 },
    }),
    listDayTiers: async () => ([
      { days: 1, duration_key: '1_day', amount_cents: 2000 },
      { days: 3, duration_key: '3_days', amount_cents: 5400 },
    ]),
  });
  ok('selected 1_day rejected when authoritative base is 3_days (not span/base owner)',
    sel1When3Base.ok === false
      && sel1When3Base.reason === 'rental_duration_not_compatible'
      && !Array.isArray(sel1When3Base.records),
    JSON.stringify(sel1When3Base));

  // Canonical-only payloads still untouched (no generic authority).
  const canonicalOnly = await prepareGenericRentalsForCreate({
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    serviceDate: '2026-08-01',
    pgClient: {},
    calendarDayCount: 5,
    bookingDurationKey: '5_days',
    rentals: [{ offering_key: 'board_rental', duration_key: 'banana', quantity: 1 }],
    listOfferings: async () => catalog,
    loadRule: makeLoadRule(dayTable),
  });
  ok('canonical-only payload preserved (empty generic, no reject on banana key)',
    canonicalOnly.ok === true
      && Array.isArray(canonicalOnly.records)
      && canonicalOnly.records.length === 0
      && Array.isArray(canonicalOnly.genericRentals)
      && canonicalOnly.genericRentals.length === 0,
    JSON.stringify(canonicalOnly));

  // BLOCKER 2: longest→shortest probing must fail closed on integrity errors,
  // never skip a price_scope_mismatch / unverified / malformed row to a shorter valid tier.
  const scopeMismatchTierProbe = await prepareGenericRentalsForCreate({
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    serviceDate: '2026-08-01',
    pgClient: {},
    calendarDayCount: 5,
    bookingDurationKey: '5_days',
    rentals: [{ offering_key: 'kayak_rental', duration_key: '1_day', quantity: 1 }],
    listOfferings: async () => catalog,
    // No listDayTiers — force longest→shortest resolveGenericRentalPrice probes.
    loadRule: async (params) => {
      const d = params.duration;
      if (d === '5_days' || d === '4_days' || d === '2_days') {
        return { status: 'not_found' };
      }
      if (d === '3_days') {
        // Found row with wrong item_code → price_scope_mismatch (authoritative integrity).
        return {
          status: 'found',
          amount_cents: 5400,
          currency: 'EUR',
          item_code: 'board_rental__3_days',
          unit: 'day',
          location_id: 'sunset-somo',
        };
      }
      if (d === '1_day') {
        return {
          status: 'found',
          amount_cents: 2000,
          currency: 'EUR',
          item_code: 'kayak_rental__1_day',
          unit: 'day',
          location_id: 'sunset-somo',
        };
      }
      return { status: 'not_found' };
    },
  });
  ok('5d probe: 3d scope mismatch rejects (never price via valid 1_day)',
    scopeMismatchTierProbe.ok === false
      && scopeMismatchTierProbe.reason === 'price_scope_mismatch'
      && !Array.isArray(scopeMismatchTierProbe.records),
    JSON.stringify(scopeMismatchTierProbe));

  const unitMismatchTierProbe = await prepareGenericRentalsForCreate({
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    serviceDate: '2026-08-01',
    pgClient: {},
    calendarDayCount: 5,
    bookingDurationKey: '5_days',
    rentals: [{ offering_key: 'kayak_rental', duration_key: '1_day', quantity: 1 }],
    listOfferings: async () => catalog,
    loadRule: async (params) => {
      const d = params.duration;
      if (d === '5_days' || d === '4_days' || d === '2_days') return { status: 'not_found' };
      if (d === '3_days') {
        return {
          status: 'found',
          amount_cents: 5400,
          currency: 'EUR',
          item_code: 'kayak_rental__3_days',
          unit: 'session', // billing unit mismatch
          location_id: 'sunset-somo',
        };
      }
      if (d === '1_day') {
        return {
          status: 'found',
          amount_cents: 2000,
          currency: 'EUR',
          item_code: 'kayak_rental__1_day',
          unit: 'day',
          location_id: 'sunset-somo',
        };
      }
      return { status: 'not_found' };
    },
  });
  ok('5d probe: 3d unit mismatch rejects (never price via valid 1_day)',
    unitMismatchTierProbe.ok === false
      && unitMismatchTierProbe.reason === 'price_scope_mismatch'
      && !Array.isArray(unitMismatchTierProbe.records),
    JSON.stringify(unitMismatchTierProbe));

  const invalidLocTierProbe = await prepareGenericRentalsForCreate({
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    serviceDate: '2026-08-01',
    pgClient: {},
    calendarDayCount: 5,
    bookingDurationKey: '5_days',
    rentals: [{ offering_key: 'kayak_rental', duration_key: '1_day', quantity: 1 }],
    listOfferings: async () => catalog,
    loadRule: async (params) => {
      const d = params.duration;
      if (d === '5_days' || d === '4_days' || d === '2_days') return { status: 'not_found' };
      if (d === '3_days') return { status: 'invalid_location' };
      if (d === '1_day') {
        return {
          status: 'found',
          amount_cents: 2000,
          currency: 'EUR',
          item_code: 'kayak_rental__1_day',
          unit: 'day',
          location_id: 'sunset-somo',
        };
      }
      return { status: 'not_found' };
    },
  });
  ok('5d probe: 3d invalid_location rejects (never price via valid 1_day)',
    invalidLocTierProbe.ok === false
      && invalidLocTierProbe.reason === 'price_not_found'
      && invalidLocTierProbe.status === 'invalid_location'
      && !Array.isArray(invalidLocTierProbe.records),
    JSON.stringify(invalidLocTierProbe));

  const unverifiedTierProbe = await prepareGenericRentalsForCreate({
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    serviceDate: '2026-08-01',
    pgClient: {},
    calendarDayCount: 5,
    bookingDurationKey: '5_days',
    rentals: [{ offering_key: 'kayak_rental', duration_key: '1_day', quantity: 1 }],
    listOfferings: async () => catalog,
    loadRule: async (params) => {
      const d = params.duration;
      if (d === '5_days' || d === '4_days' || d === '2_days') return { status: 'not_found' };
      if (d === '3_days') {
        return {
          status: 'found',
          amount_cents: 5400,
          currency: 'EUR',
          item_code: 'kayak_rental__3_days',
          unit: 'day',
          location_id: 'sunset-somo',
          pricing_status: 'draft',
        };
      }
      if (d === '1_day') {
        return {
          status: 'found',
          amount_cents: 2000,
          currency: 'EUR',
          item_code: 'kayak_rental__1_day',
          unit: 'day',
          location_id: 'sunset-somo',
        };
      }
      return { status: 'not_found' };
    },
  });
  ok('5d probe: 3d price_unverified rejects (never price via valid 1_day)',
    unverifiedTierProbe.ok === false
      && unverifiedTierProbe.reason === 'price_unverified'
      && !Array.isArray(unverifiedTierProbe.records),
    JSON.stringify(unverifiedTierProbe));

  // ── 2) No surfer/guest force on independent rental qty ───────────────────
  console.log('\n[2] Independent qty — no surfer force');
  const forced = applyNoLessonEquipmentQtyFromSurfers(
    {
      surfer_count: 1,
      components: { surfboard: { quantity: 4 }, wetsuit: { quantity: 8 } },
    },
    [
      { offering_key: 'board_rental', duration_key: '1_day', quantity: 4 },
      { offering_key: 'wetsuit_rental', duration_key: '1_day', quantity: 8 },
    ],
  );
  ok('no-lesson preserves independent board qty 4 (not forced to 1 surfer)',
    forced.ok
      && forced.rentals
      && forced.rentals.find((r) => r.offering_key === 'board_rental').quantity === 4
      && forced.rentals.find((r) => r.offering_key === 'wetsuit_rental').quantity === 8
      && forced.body.components.surfboard.quantity === 4
      && forced.body.components.wetsuit.quantity === 8,
    JSON.stringify(forced));

  // ── 3) Projection: multi-day offers data-driven durations; no fixed whitelist invent ─
  console.log('\n[3] Duration projection data-driven');
  const prices = [
    { offering_key: 'kayak_rental', unit: '1_day', amount_cents: 2000, active: true, category: 'rental', location_id: 'sunset-somo', client_slug: 'sunset' },
    { offering_key: 'kayak_rental', unit: '3_days', amount_cents: 5400, active: true, category: 'rental', location_id: 'sunset-somo', client_slug: 'sunset' },
    { offering_key: 'kayak_rental', unit: '7_days', amount_cents: 10500, active: true, category: 'rental', location_id: 'sunset-somo', client_slug: 'sunset' },
    { offering_key: 'kayak_rental', unit: '4_hours', amount_cents: 3000, active: true, category: 'rental', location_id: 'sunset-somo', client_slug: 'sunset' },
    { offering_key: 'kayak_rental', unit: '9_hours', amount_cents: 4500, active: true, category: 'rental', location_id: 'sunset-somo', client_slug: 'sunset' },
  ];
  const offerings = [{ offering_key: 'kayak_rental', label: 'Sea Kayak', active: true, location_id: 'sunset-somo', client_slug: 'sunset' }];
  const proj1 = rentalAvail.scheduleProjectStandaloneRentals({
    offerings, prices, locationId: 'sunset-somo', clientSlug: 'sunset', dateDurationKey: '1_day',
  });
  const kayak1 = (proj1 || []).find((o) => o.offering_key === 'kayak_rental');
  const hourKeys = (kayak1 && kayak1.durations || []).map((d) => d.duration_key);
  ok('single-day projects arbitrary admin hours (4_hours, 9_hours)',
    hourKeys.indexOf('4_hours') >= 0 && hourKeys.indexOf('9_hours') >= 0,
    JSON.stringify(hourKeys));

  // ── 4) Invoice truthful qty × duration ───────────────────────────────────
  console.log('\n[4] Invoice line quantity truth');
  const inv = formatServiceRecordInvoiceLineText({
    service_type: 'addon_service',
    quantity: 4,
    amount_due_cents: 18000,
    metadata: {
      rental_offering: true,
      offering_key: 'kayak_rental',
      offering_label: 'Sea Kayak',
      duration_key: '3_days',
      unit_cents: 4500,
      rental_units: 4,
      package_repeat_count: 1,
      pricing_mode: 'exact_duration_package',
    },
  });
  ok('invoice shows unit qty 4 and money (not guest/people double-count)',
    /Sea Kayak/.test(inv)
      && /4/.test(inv)
      && (/180\.00|€180/.test(inv) || /18000/.test(inv) === false)
      && !/people/i.test(inv),
    inv);

  // ── 5) Rendered Create DOM: independent qty stepper path ─────────────────
  console.log('\n[5] Rendered Create rental qty (Staff /staff/ui)');
  let ui;
  try {
    ui = await fetchRenderedStaffUi();
  } catch (err) {
    ok('fetch /staff/ui', false, String(err && err.message || err));
    ui = null;
  }
  if (ui) {
    const html = ui.html;
    ok('/staff/ui serves create rental qty input class',
      /ps-create-rental-qty-input/.test(html));
    // Must not force no-lesson qty from surfers in read path.
    ok('Create read does not force no-lesson qty from surfers',
      !/if \(noLesson\)[\s\S]{0,200}scheduleReadCreateSurferCount[\s\S]{0,80}qty = snNo/.test(html)
      && !/No lesson: never trust an independently editable equipment quantity/.test(html),
      'obsolete surfer-owned qty still present in served UI');
    ok('Create render defaults selected rental qty to 1 (not surfers)',
      /qty = 1|quantity:\s*1|value="' \+ escHtml\(String\(qty\)\)|"value="1"/.test(html)
      || /data-rental-quantity/.test(html)
      || /defaultQty\s*=\s*1|qty\s*=\s*1;/.test(html),
      'need default qty 1 on select');
    ok('rentalQty label is Qty (equipment units), not Surfers',
      /data-i18n="schedule\.create\.rentalQty">Qty</.test(html)
      || /portalT\('schedule\.create\.rentalQty'\) \|\| 'Qty'/.test(html),
      'label still Surfers or missing Qty');
    ok('int stepper helper present for − N +',
      /scheduleEnhanceIntStepper/.test(html)
      && /portal-schedule-int-stepper/.test(html));

    // Behavioral serialize: independent multi-item qty from mini DOM
    const { El } = miniDom();
    const wrap = new El({ tag: 'div', id: 'ps-create-rentals' });
    wrap.setAttribute('data-duration-key', '1_day');
    wrap.innerHTML = ''
      + '<div class="portal-schedule-create-rental-row" data-rental-offering="board_rental" data-rental-duration-key="1_day">'
      + '<input type="checkbox" class="ps-create-rental-check" data-offering-key="board_rental" checked>'
      + '<div class="portal-schedule-create-rental-qty">'
      + '<input type="number" min="1" max="99" class="ps-create-rental-qty-input" data-rental-quantity data-qty-owner="user" value="8">'
      + '</div></div>'
      + '<div class="portal-schedule-create-rental-row" data-rental-offering="wetsuit_rental" data-rental-duration-key="1_day">'
      + '<input type="checkbox" class="ps-create-rental-check" data-offering-key="wetsuit_rental" checked>'
      + '<div class="portal-schedule-create-rental-qty">'
      + '<input type="number" min="1" max="99" class="ps-create-rental-qty-input" data-rental-quantity data-qty-owner="user" value="4">'
      + '</div></div>';

    // Pure serialize owner always works:
    const sel = rentalAvail.scheduleSerializeRentalsSelection([
      { offering_key: 'board_rental', duration_key: '1_day', quantity: 8 },
      { offering_key: 'wetsuit_rental', duration_key: '1_day', quantity: 4 },
    ], '1_day', { genericOfferingKeys: [] });
    ok('serialize keeps independent board=8 and wetsuit=4',
      Array.isArray(sel)
        && sel.some((r) => r.offering_key === 'board_rental' && r.quantity === 8)
        && sel.some((r) => r.offering_key === 'wetsuit_rental' && r.quantity === 4),
      JSON.stringify(sel));

    // Guest/surfer change must not rewrite equipment qty in served source
    ok('Create payload path does not lockstep rental qty to surfers',
      !/rentWrapSync\.querySelectorAll\('input\.ps-create-rental-qty-input'\)\.forEach\(function\(inp\)\{\s*inp\.value = String\(surferCount\)/.test(html)
      && !/keep any rental qty mirrors in lockstep with surfers/.test(html),
      'obsolete lockstep still in scheduleReadCreatePayload');

    // Serializer still rejects non-canonical numbers (defense in depth).
    const bad0 = rentalAvail.scheduleSerializeRentalsSelection([
      { offering_key: 'board_rental', duration_key: '1_day', quantity: 0 },
    ], '1_day');
    const bad100 = rentalAvail.scheduleSerializeRentalsSelection([
      { offering_key: 'board_rental', duration_key: '1_day', quantity: 100 },
    ], '1_day');
    const badFrac = rentalAvail.scheduleSerializeRentalsSelection([
      { offering_key: 'board_rental', duration_key: '1_day', quantity: 2.5 },
    ], '1_day');
    const ok99 = rentalAvail.scheduleSerializeRentalsSelection([
      { offering_key: 'board_rental', duration_key: '1_day', quantity: 99 },
    ], '1_day');
    ok('serializer rejects qty 0 as defense in depth', bad0.length === 0, JSON.stringify(bad0));
    ok('qty 100 dropped or rejected', bad100.length === 0 || bad100[0].quantity <= 99, JSON.stringify(bad100));
    ok('fraction dropped', badFrac.length === 0, JSON.stringify(badFrac));
    ok('qty 99 accepted', ok99.length === 1 && ok99[0].quantity === 99, JSON.stringify(ok99));

    // ── BLOCKER B: actual Create/Edit DOM readers must fail closed on invalid qty ──
    // parseInt coerces 1.5→1, blank→default1, >99→99 — commercial intent must not be manufactured.
    console.log('\n[5b] Create/Edit DOM readers — canonical qty only (fail closed)');
    const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
    const editSrc = fs.readFileSync(
      path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-edit-ui.js'),
      'utf8',
    );
    const portalSrc = fs.readFileSync(
      path.join(ROOT, 'scripts/browser/sunset-schedule-portal-module.js'),
      'utf8',
    );
    const createReadSrc = extractFn(apiSrc, 'scheduleReadCreateRentalSelectionFromDom')
      || extractFn(html, 'scheduleReadCreateRentalSelectionFromDom');
    const editReadSrc = extractFn(editSrc, 'scheduleReadDrawerRentalSelectionFromDom');
    const createValidateSrc = extractFn(portalSrc, 'schedulePortalValidateCreatePayload');
    const editValidateSrc = extractFn(editSrc, 'scheduleDrawerValidateEditPayload');
    ok('Create DOM reader extractable', !!createReadSrc);
    ok('Edit DOM reader extractable', !!editReadSrc);
    ok('Create/Edit validators extractable', !!createValidateSrc && !!editValidateSrc);

    function buildRentalWrap(kind, qtyValues) {
      const id = kind === 'edit' ? 'ps-drawer-rentals' : 'ps-create-rentals';
      const checkCls = kind === 'edit' ? 'ps-drawer-rental-check' : 'ps-create-rental-check';
      const qtyCls = kind === 'edit' ? 'ps-drawer-rental-qty-input' : 'ps-create-rental-qty-input';
      const w = new El({ tag: 'div', id });
      w.setAttribute('data-duration-key', '1_day');
      const offerings = ['board_rental', 'wetsuit_rental', 'kayak_rental'];
      let htmlRows = '';
      for (let i = 0; i < qtyValues.length; i += 1) {
        const key = offerings[i] || ('rental_' + (i + 1));
        const q = qtyValues[i];
        htmlRows += ''
          + '<div class="portal-schedule-create-rental-row" data-rental-offering="' + key + '"'
          + ' data-rental-duration-key="1_day">'
          + '<input type="checkbox" class="' + checkCls + '" data-offering-key="' + key + '" checked>'
          + '<div class="portal-schedule-create-rental-qty">'
          + '<input type="number" min="1" max="99" class="' + qtyCls + '"'
          + ' data-rental-quantity data-qty-owner="user" value="' + String(q) + '">'
          + '</div></div>';
      }
      w.innerHTML = htmlRows;
      return w;
    }

    function loadCreateReader(rentWrap) {
      const sandbox = {
        el(id) {
          if (id === 'ps-create-rentals') return rentWrap;
          return null;
        },
        scheduleSerializeRentalsSelection: rentalAvail.scheduleSerializeRentalsSelection,
        scheduleCreateDateSpanForRentals() { return { from: '2026-08-01', to: '2026-08-01' }; },
        scheduleRentalDurationKeyFromDates() { return '1_day'; },
        scheduleEnumerateDates() { return ['2026-08-01']; },
      };
      vm.runInNewContext(
        createReadSrc + '\nthis.scheduleReadCreateRentalSelectionFromDom = scheduleReadCreateRentalSelectionFromDom;',
        sandbox,
      );
      return sandbox.scheduleReadCreateRentalSelectionFromDom();
    }

    function loadEditReader(rentWrap) {
      const sandbox = {
        el(id) {
          if (id === 'ps-drawer-rentals') return rentWrap;
          return null;
        },
        scheduleSerializeRentalsSelection: rentalAvail.scheduleSerializeRentalsSelection,
      };
      vm.runInNewContext(
        editReadSrc + '\nthis.scheduleReadDrawerRentalSelectionFromDom = scheduleReadDrawerRentalSelectionFromDom;',
        sandbox,
      );
      return sandbox.scheduleReadDrawerRentalSelectionFromDom();
    }

    function validateCreate(rentals) {
      const sandbox = {
        schedulePortalIsValidCreatePhone() { return true; },
        schedulePortalHasSellableIntent(p) {
          return !!(p && Array.isArray(p.rentals) && p.rentals.length);
        },
        schedulePortalInclusiveDateCount() { return 1; },
        schedulePortalCanonicalDateIso(d) { return d; },
        schedulePortalMadridTodayIso() { return '2026-01-01'; },
        schedulePortalValidatePrivateLessonCreate() { return { ok: true }; },
        scheduleReadCreateSurferCount() { return 1; },
      };
      vm.runInNewContext(
        createValidateSrc + '\nthis.schedulePortalValidateCreatePayload = schedulePortalValidateCreatePayload;',
        sandbox,
      );
      return sandbox.schedulePortalValidateCreatePayload({
        guest_name: 'Ada',
        guest_phone: '+34600000000',
        date_from: '2026-08-01',
        date_to: '2026-08-01',
        components: {},
        rentals,
        surfer_count: 1,
      }, { soft: false });
    }

    function validateEdit(rentals) {
      const sandbox = {
        el() { return null; },
        scheduleDrawerMainActivityValue() { return 'none'; },
        scheduleDrawerReadSurferCount() { return 1; },
        schedulePortalInclusiveDateCount() { return 1; },
        schedulePortalValidatePrivateLessonCreate() { return { ok: true }; },
      };
      vm.runInNewContext(
        editValidateSrc + '\nthis.scheduleDrawerValidateEditPayload = scheduleDrawerValidateEditPayload;',
        sandbox,
      );
      return sandbox.scheduleDrawerValidateEditPayload({
        guest_name: 'Ada',
        guest_phone: '+34600000000',
        date_from: '2026-08-01',
        date_to: '2026-08-01',
        components: {},
        rentals,
        surfer_count: 1,
      });
    }

    // Non-default valid quantities 2/3/4 through actual Create + Edit readers.
    const createValid = loadCreateReader(buildRentalWrap('create', ['2', '3', '4']));
    const editValid = loadEditReader(buildRentalWrap('edit', ['2', '3', '4']));
    ok('Create DOM reader preserves nondefault qty 2/3/4 into selection',
      Array.isArray(createValid)
        && createValid.length === 3
        && createValid.find((r) => r.offering_key === 'board_rental' && r.quantity === 2)
        && createValid.find((r) => r.offering_key === 'wetsuit_rental' && r.quantity === 3)
        && createValid.find((r) => r.offering_key === 'kayak_rental' && r.quantity === 4),
      JSON.stringify(createValid));
    ok('Edit DOM reader preserves nondefault qty 2/3/4 into selection',
      Array.isArray(editValid)
        && editValid.length === 3
        && editValid.find((r) => r.offering_key === 'board_rental' && r.quantity === 2)
        && editValid.find((r) => r.offering_key === 'wetsuit_rental' && r.quantity === 3)
        && editValid.find((r) => r.offering_key === 'kayak_rental' && r.quantity === 4),
      JSON.stringify(editValid));
    ok('Create validation accepts canonical qty 2/3/4',
      validateCreate(createValid).ok === true,
      JSON.stringify(validateCreate(createValid)));
    ok('Edit validation accepts canonical qty 2/3/4',
      validateEdit(editValid).ok === true,
      JSON.stringify(validateEdit(editValid)));

    // Invalid explicit values must not manufacture 1/99 or silently omit without fail.
    const invalidCases = [
      { label: 'blank', value: '' },
      { label: 'fraction', value: '1.5' },
      { label: 'text', value: 'abc' },
      { label: 'zero', value: '0' },
      { label: 'negative', value: '-3' },
      { label: 'over99', value: '100' },
    ];
    for (const c of invalidCases) {
      const createBad = loadCreateReader(buildRentalWrap('create', [c.value]));
      const editBad = loadEditReader(buildRentalWrap('edit', [c.value]));
      const createHasManufactured = Array.isArray(createBad)
        && createBad.some((r) => r.quantity === 1 || r.quantity === 99);
      const editHasManufactured = Array.isArray(editBad)
        && editBad.some((r) => r.quantity === 1 || r.quantity === 99);
      // Must not silently omit selected rental as "no intent" without validation failure.
      const createGate = validateCreate(createBad);
      const editGate = validateEdit(editBad);
      const createSilentOmit = Array.isArray(createBad) && createBad.length === 0;
      const editSilentOmit = Array.isArray(editBad) && editBad.length === 0;
      ok('Create reader/validation fail-closed on ' + c.label
        + ' (no manufacture 1/99; block; no silent omit without fail)',
        createGate.ok === false
          && !createHasManufactured
          && !(createSilentOmit && createGate.ok !== false),
        'sel=' + JSON.stringify(createBad) + ' gate=' + JSON.stringify(createGate));
      ok('Edit reader/validation fail-closed on ' + c.label
        + ' (no manufacture 1/99; block; no silent omit without fail)',
        editGate.ok === false
          && !editHasManufactured
          && !(editSilentOmit && editGate.ok !== false),
        'sel=' + JSON.stringify(editBad) + ' gate=' + JSON.stringify(editGate));
      // Explicit: silent omit of selected row is forbidden even if gate somehow ok.
      ok('Create does not silently omit selected rental for ' + c.label,
        !(createSilentOmit && createGate.ok === true)
          && (createSilentOmit ? createGate.ok === false : true)
          && (createSilentOmit === false || createGate.ok === false),
        'silent-omit-with-ok forbidden; sel=' + JSON.stringify(createBad));
      // Stronger: never omit selected checked rental on invalid qty.
      ok('Create keeps selected rental present for invalid ' + c.label + ' (validation blocks)',
        Array.isArray(createBad) && createBad.length >= 1 && createGate.ok === false,
        JSON.stringify({ createBad, createGate }));
      ok('Edit keeps selected rental present for invalid ' + c.label + ' (validation blocks)',
        Array.isArray(editBad) && editBad.length >= 1 && editGate.ok === false,
        JSON.stringify({ editBad, editGate }));
    }

    // Real change/blur clamp path: entering 0 must not deselect or reset the rental.
    function runZeroClamp(kind) {
      const wrap = buildRentalWrap(kind, ['0']);
      const qtyCls = kind === 'edit' ? '.ps-drawer-rental-qty-input' : '.ps-create-rental-qty-input';
      const checkCls = kind === 'edit' ? '.ps-drawer-rental-check' : '.ps-create-rental-check';
      const qty = wrap.querySelector(qtyCls);
      const check = wrap.querySelector(checkCls);
      const owner = kind === 'edit' ? editSrc : html;
      const clampName = kind === 'edit'
        ? 'scheduleDrawerClampRentalQtyInput'
        : 'scheduleClampCreateRentalQtyInput';
      const clampSrc = extractFn(owner, clampName);
      const parserSrc = extractFn(owner, 'scheduleParseRentalEquipmentQtyValue');
      const sandbox = {};
      vm.runInNewContext(
        parserSrc + '\n' + clampSrc + '\nthis.clamp = ' + clampName + ';',
        sandbox,
      );
      sandbox.clamp(qty, wrap);
      return { checked: !!check.checked, value: String(qty.value) };
    }
    const createZeroClamp = runZeroClamp('create');
    const editZeroClamp = runZeroClamp('edit');
    ok('Create change path keeps selected qty 0 visibly invalid (no deselect/reset)',
      createZeroClamp.checked && createZeroClamp.value === '0', JSON.stringify(createZeroClamp));
    ok('Edit change path keeps selected qty 0 visibly invalid (no deselect/reset)',
      editZeroClamp.checked && editZeroClamp.value === '0', JSON.stringify(editZeroClamp));

    ok('Edit does not force no-lesson rental qty from surfers',
      !/Force hidden no-lesson rental qty mirrors to live booking Surfers/.test(editSrc)
      && !/data-qty-owner', 'surfers'/.test(editSrc.replace(/course-equipment[\s\S]{0,40}surfers/g, '')),
      'edit still couples rental qty to surfers');
    ok('Edit hydrates per-item quantity from seed rentals',
      /data-seed-rentals/.test(editSrc)
      && /quantity/.test(editSrc)
      && /ps-drawer-rental-qty-input/.test(editSrc));

    try { ui.kill(); } catch (_e) { /* */ }
  }

  // ── 6) Authoritative quote line multiplies qty once ──────────────────────
  console.log('\n[6] Quote line qty × duration once');
  if (cont5q2 && cont5q2.ok) {
    const q = buildGenericRentalAuthoritativeQuote(cont5q2.records);
    ok('authoritative quote total = 18000 for 5d×2 continued',
      q.total_cents === 18000
        && q.line_items[0].quantity === 2,
      JSON.stringify(q));
  } else {
    ok('authoritative quote total = 18000 for 5d×2 continued', false, 'depends on cont5q2');
  }

  // ── 7) resolveGenericRentalPrice still multiplies qty only ───────────────
  console.log('\n[7] resolveGenericRentalPrice qty multiply');
  const priced = await resolveGenericRentalPrice({
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offeringKey: 'kayak_rental',
    durationKey: '2_hours',
    quantity: 8,
    loadRule: makeLoadRule(dayTable),
  });
  ok('2_hours unit 1800 × qty 8 = 14400',
    priced.ok && priced.amount_cents === 14400 && priced.quantity === 8,
    JSON.stringify(priced));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
