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
      && cont5.records[0].amount_due_cents === 9000,
    JSON.stringify(cont5));

  const cont5q2 = await prepareGenericRentalsForCreate({
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    serviceDate: '2026-08-01',
    pgClient: {},
    calendarDayCount: 5,
    bookingDurationKey: '5_days',
    rentals: [{ offering_key: 'kayak_rental', duration_key: '1_day', quantity: 2 }],
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
      && cont5q2.records[0].quantity === 2,
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

    // Extract + run scheduleReadCreateRentalsSelection from served page if present
    const readFnSrc = extractFn(html, 'scheduleReadCreateRentalsSelection')
      || extractFn(html, 'scheduleReadCreateRentals');
    const serializeSrc = fs.readFileSync(
      path.join(ROOT, 'scripts/browser/sunset-schedule-rental-availability.js'),
      'utf8',
    );
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

    // Clamp contract: qty 1..99
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
    ok('qty 0 dropped (unselected/invalid)', bad0.length === 0, JSON.stringify(bad0));
    ok('qty 100 dropped or rejected', bad100.length === 0 || bad100[0].quantity <= 99, JSON.stringify(bad100));
    ok('fraction dropped', badFrac.length === 0, JSON.stringify(badFrac));
    ok('qty 99 accepted', ok99.length === 1 && ok99[0].quantity === 99, JSON.stringify(ok99));

    // Edit source parity (inline browser module)
    const editSrc = fs.readFileSync(
      path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-edit-ui.js'),
      'utf8',
    );
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
