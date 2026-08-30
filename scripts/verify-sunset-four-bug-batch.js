'use strict';

/**
 * verify:sunset-four-bug-batch
 *
 * Focused vertical regression for operator-reported Sunset staging bugs:
 *  1) Free course add-on (€0 configured) must not block payment-link reprice
 *  2) Today’s Prep shows exact course add-on offering + top-2 other rentals
 *  3) Atomic rental /commit accepts new 2_days duration beside existing prices
 *  4) Rental write error is operation-scoped and clears on nav/cancel/success
 *
 * Offline only — no live systems. Run:
 *   node scripts/verify-sunset-four-bug-batch.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

let failed = 0;
function ok(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    return;
  }
  failed += 1;
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
}

function section(title) {
  console.log(`\n=== ${title} ===\n`);
}

/* ── Minimal DOM (same pattern as cockpit offline gates) ─────────────────── */
function createMinimalDocument() {
  function Node(tag) {
    this.tagName = String(tag || '').toUpperCase();
    this.className = '';
    this._classList = new Set();
    this.children = [];
    this.childNodes = this.children;
    this.attributes = Object.create(null);
    this._text = '';
    this._html = '';
    this.style = {
      _props: Object.create(null),
      setProperty(k, v) {
        this._props[k] = String(v);
        this[k] = String(v);
      },
      display: '',
    };
    this._listeners = Object.create(null);
    this.ownerDocument = null;
    this.parentNode = null;
    this.id = '';
    this.type = '';
    this.title = '';
  }
  Object.defineProperty(Node.prototype, 'textContent', {
    get() {
      if (!this.children.length) return this._text;
      return this.children.map((c) => c.textContent).join('');
    },
    set(v) {
      this.children.length = 0;
      this._html = '';
      this._text = v == null ? '' : String(v);
    },
  });
  Object.defineProperty(Node.prototype, 'innerHTML', {
    get() {
      return this._html || this.children.map((c) => c.textContent).join('');
    },
    set(v) {
      this.children.length = 0;
      this._text = '';
      this._html = v == null ? '' : String(v);
    },
  });
  Object.defineProperty(Node.prototype, 'classList', {
    get() {
      const self = this;
      return {
        add(c) {
          self._classList.add(c);
          const parts = new Set(String(self.className || '').split(/\s+/).filter(Boolean));
          parts.add(c);
          self.className = Array.from(parts).join(' ');
        },
        contains(c) {
          return self._classList.has(c)
            || String(self.className || '').split(/\s+/).includes(c);
        },
        remove(c) {
          self._classList.delete(c);
          self.className = String(self.className || '')
            .split(/\s+/)
            .filter((x) => x && x !== c)
            .join(' ');
        },
        toggle(c, force) {
          if (force === true || (force == null && !this.contains(c))) this.add(c);
          else this.remove(c);
        },
      };
    },
  });
  Node.prototype.setAttribute = function (k, v) {
    this.attributes[k] = String(v);
    if (k === 'id') this.id = String(v);
    if (k === 'class') this.className = String(v);
    if (k === 'hidden') this.hidden = true;
  };
  Node.prototype.getAttribute = function (k) {
    if (k === 'id') return this.id || null;
    if (k === 'class') return this.className || null;
    if (k === 'hidden') return this.hidden ? '' : null;
    return this.attributes[k] != null ? this.attributes[k] : null;
  };
  Node.prototype.removeAttribute = function (k) {
    delete this.attributes[k];
    if (k === 'hidden') this.hidden = false;
    if (k === 'class') this.className = '';
    if (k === 'id') this.id = '';
  };
  Node.prototype.hasAttribute = function (k) {
    return this.getAttribute(k) != null;
  };
  Node.prototype.appendChild = function (c) {
    if (!c) return c;
    if (typeof c === 'string') {
      const t = this.ownerDocument.createTextNode(c);
      t.parentNode = this;
      this.children.push(t);
      return t;
    }
    c.parentNode = this;
    c.ownerDocument = this.ownerDocument;
    this.children.push(c);
    return c;
  };
  Node.prototype.addEventListener = function (type, fn) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(fn);
  };
  Node.prototype.removeEventListener = function (type, fn) {
    if (!this._listeners[type]) return;
    this._listeners[type] = this._listeners[type].filter((f) => f !== fn);
  };
  Node.prototype.dispatchEvent = function (ev) {
    const type = ev && ev.type;
    const list = (this._listeners[type] || []).slice();
    for (const fn of list) fn.call(this, ev);
    return !ev || ev.defaultPrevented !== true;
  };
  Node.prototype.contains = function (node) {
    if (node === this) return true;
    for (const c of this.children || []) {
      if (c.contains && c.contains(node)) return true;
    }
    return false;
  };
  Node.prototype.closest = function (sel) {
    let cur = this;
    while (cur && cur.tagName) {
      if (nodeMatches(cur, sel)) return cur;
      cur = cur.parentNode;
    }
    return null;
  };
  function nodeMatches(n, sel) {
    if (!n || !sel) return false;
    const s = String(sel).trim();
    // compound first when multiple tokens: .tab-panel.active / .tab-btn[data-tab="admin"]
    const parts = s.match(/(\.[a-zA-Z0-9_-]+|\[[^\]]+\]|[a-zA-Z][\w-]*)/g) || [];
    if (parts.length > 1) return parts.every((p) => nodeMatches(n, p));
    if (s.startsWith('#') && n.id === s.slice(1)) return true;
    if (s.startsWith('.')) {
      return String(n.className || '').split(/\s+/).includes(s.slice(1));
    }
    const attr = /^\[([a-zA-Z0-9_-]+)(?:=["']?([^"'\]]+)["']?)?\]$/.exec(s);
    if (attr) {
      const got = n.getAttribute && n.getAttribute(attr[1]);
      return got != null && (attr[2] == null || got === attr[2]);
    }
    if (/^[a-zA-Z][\w-]*$/.test(s) && n.tagName === s.toUpperCase()) return true;
    return false;
  }
  function collectMatches(root, sel, out) {
    const walk = (n) => {
      if (!n || !n.tagName) return;
      if (nodeMatches(n, sel)) out.push(n);
      (n.children || []).forEach(walk);
    };
    walk(root);
  }
  Node.prototype.querySelector = function (sel) {
    return (this.querySelectorAll(sel)[0] || null);
  };
  Node.prototype.querySelectorAll = function (sel) {
    const out = [];
    collectMatches(this, String(sel || ''), out);
    return out;
  };
  Node.prototype.replaceChildren = function () {
    this.children.length = 0;
    this._text = '';
    this._html = '';
    for (let i = 0; i < arguments.length; i += 1) {
      this.appendChild(arguments[i]);
    }
  };
  Object.defineProperty(Node.prototype, 'dataset', {
    get() {
      const self = this;
      const ds = {};
      for (const k of Object.keys(self.attributes || {})) {
        if (!k.startsWith('data-')) continue;
        const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        Object.defineProperty(ds, camel, {
          enumerable: true,
          configurable: true,
          get() { return self.attributes[k]; },
          set(v) { self.attributes[k] = String(v); },
        });
      }
      return new Proxy(ds, {
        get(t, prop) {
          if (prop in t) return t[prop];
          const attr = 'data-' + String(prop).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
          return self.attributes[attr];
        },
        set(t, prop, v) {
          const attr = 'data-' + String(prop).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
          self.attributes[attr] = String(v);
          return true;
        },
      });
    },
  });

  const doc = {
    body: null,
    documentElement: null,
    head: null,
    createElement(tag) {
      const n = new Node(tag);
      n.ownerDocument = doc;
      return n;
    },
    createTextNode(t) {
      const n = new Node('#text');
      n.ownerDocument = doc;
      n._text = String(t == null ? '' : t);
      return n;
    },
    getElementById(id) {
      const walk = (node) => {
        if (!node) return null;
        if (node.id === id) return node;
        for (const c of node.children || []) {
          const hit = walk(c);
          if (hit) return hit;
        }
        return null;
      };
      return walk(doc.body) || walk(doc.head);
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    },
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => {
        if (!n) return;
        if (n.tagName && n.querySelectorAll) {
          // Use node-level matcher via collect on each root child tree.
        }
        if (n.querySelectorAll && n !== doc) {
          // no-op; walk body/head below
        }
        (n.children || []).forEach(walk);
      };
      void walk;
      if (doc.body && doc.body.querySelectorAll) {
        out.push(...doc.body.querySelectorAll(sel));
      }
      if (doc.head && doc.head.querySelectorAll) {
        out.push(...doc.head.querySelectorAll(sel));
      }
      // Also match body/head themselves.
      if (doc.body && nodeMatches(doc.body, String(sel || ''))) out.unshift(doc.body);
      return out;
    },
  };
  doc.body = doc.createElement('body');
  doc.head = doc.createElement('head');
  doc.documentElement = doc.createElement('html');
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  return doc;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bug 1 — free add-on payment link reprice
// ─────────────────────────────────────────────────────────────────────────────
async function bug1FreeAddonPaymentLink() {
  section('Bug 1: free configured add-on must not fail payment-link reprice');

  process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'true';

  // Clear require cache so flag is observed if modules already loaded.
  const priceResolvePath = require.resolve('./lib/sunset-admin-price-resolve');
  const linksPath = require.resolve('./lib/sunset-stripe-payment-links');
  delete require.cache[priceResolvePath];
  delete require.cache[linksPath];

  const {
    priceSunsetBookingServices,
    findPriceCents,
  } = require('./lib/sunset-stripe-payment-links');
  const { resolveActiveSunsetAdminPrice } = require('./lib/sunset-admin-price-resolve');

  const zeroPriceRow = {
    category: 'rental',
    offering_key: 'surfboard_wetsuit',
    item_code: 'surfboard_wetsuit__during_course',
    unit: 'during_course',
    amount_cents: 0,
    amount: 0,
    active: true,
    source: 'db',
    pricing_status: 'confirmed',
  };
  const missingRowCatalog = [
    {
      category: 'rental',
      offering_key: 'other_rental',
      item_code: 'other_rental__1_day',
      unit: '1_day',
      amount_cents: 1500,
      active: true,
      source: 'db',
      pricing_status: 'confirmed',
    },
  ];

  const foundZero = findPriceCents([zeroPriceRow], 'rental', 'surfboard_wetsuit', 'during_course');
  ok(
    'findPriceCents returns 0 for explicit configured zero (not null)',
    foundZero === 0,
    String(foundZero),
  );

  const missing = findPriceCents(missingRowCatalog, 'rental', 'surfboard_wetsuit', 'during_course');
  ok('findPriceCents returns null for missing add-on price', missing == null, String(missing));

  const zeroLive = await resolveActiveSunsetAdminPrice(null, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    quantity: 1,
    itemType: 'rental',
    itemCode: 'surfboard_wetsuit__during_course',
    billingUnit: 'item',
    loadRule: async () => ({
      status: 'found',
      amount_cents: 0,
      currency: 'EUR',
      id: '00000000-0000-4000-8000-000000000001',
      location_id: 'sunset-somo',
    }),
  });
  ok(
    'resolveActiveSunsetAdminPrice accepts explicit zero (ok:true, amount 0)',
    zeroLive && zeroLive.ok === true && zeroLive.amount_cents === 0,
    JSON.stringify(zeroLive),
  );

  const missingLive = await resolveActiveSunsetAdminPrice(null, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    quantity: 1,
    itemType: 'rental',
    itemCode: 'ghost_fins__1_day',
    billingUnit: 'day',
    loadRule: async () => ({ status: 'not_found' }),
  });
  ok(
    'missing Admin price remains fail-closed',
    missingLive && missingLive.ok === false
      && /price_not_configured|not_found|unresolved/i.test(String(missingLive.reason || '')),
    JSON.stringify(missingLive),
  );

  const bookingId = '11111111-1111-4111-8111-111111111111';
  const svcCourseId = '22222222-2222-4222-8222-222222222222';
  const svcAddonId = '33333333-3333-4333-8333-333333333333';

  function makeServices(addonMeta, addonDue) {
    return [
      {
        id: svcCourseId,
        service_type: 'surf_lesson',
        service_date: '2026-08-01',
        quantity: 1,
        amount_due_cents: 3500,
        metadata: {
          component: 'course',
          course_id: 'manana',
          staff_ui_service_type: 'course',
          location_id: 'sunset-somo',
        },
      },
      {
        id: svcAddonId,
        service_type: 'addon_service',
        service_date: '2026-08-01',
        quantity: 1,
        amount_due_cents: addonDue,
        metadata: addonMeta,
      },
    ];
  }

  function makePg(services) {
    return {
      async query(sql) {
        const q = String(sql || '').replace(/\s+/g, ' ');
        if (/FROM bookings b INNER JOIN clients/i.test(q) && /metadata/i.test(q)) {
          return {
            rows: [{ metadata: { location_id: 'sunset-somo', staff_manual_schedule: true } }],
          };
        }
        if (/FROM booking_service_records/i.test(q) && /SELECT id/i.test(q)) {
          return { rows: services.map((s) => ({ ...s })) };
        }
        if (/UPDATE booking_service_records SET amount_due_cents/i.test(q)) {
          return { rows: [] };
        }
        if (/UPDATE bookings/i.test(q) && /total_amount_cents/i.test(q)) {
          return { rows: [] };
        }
        return { rows: [] };
      },
    };
  }

  const freeDuringMeta = {
    course_equipment: true,
    course_equipment_mode: 'during_course',
    offering_key: 'surfboard_wetsuit',
    label: 'Surfboard + Wetsuit',
    during_course_price_cents: 0,
    all_day_price_cents: 2000,
    unit_amount_cents: 0,
    location_id: 'sunset-somo',
    pricing_provenance: 'course_owned_equipment',
  };

  const priced = await priceSunsetBookingServices(
    makePg(makeServices(freeDuringMeta, 0)),
    'sunset',
    bookingId,
  );
  ok(
    'priceSunsetBookingServices accepts free CE add-on + paid course',
    priced && priced.ok === true && priced.total_cents === 3500,
    JSON.stringify(priced),
  );
  ok(
    'does not emit no_price_for_addon_service for free configured CE',
    !(priced && /no_price_for_addon_service/i.test(String(priced.error || ''))),
    JSON.stringify(priced),
  );

  const pricedMissing = await priceSunsetBookingServices(
    makePg(makeServices({
      offering_key: 'never_configured_addon_xyz',
      rental_offering: true,
      generic_rental: true,
      duration_key: '1_day',
      location_id: 'sunset-somo',
    }, 0)),
    'sunset',
    bookingId,
  );
  ok(
    'missing/unpriced add-on still fail-closed',
    pricedMissing && pricedMissing.ok === false
      && /no_price_for_/i.test(String(pricedMissing.error || '')),
    JSON.stringify(pricedMissing),
  );

  const freeAllDayMeta = {
    course_equipment: true,
    course_equipment_mode: 'all_day',
    offering_key: 'surfboard_wetsuit',
    label: 'Surfboard + Wetsuit',
    during_course_price_cents: 1500,
    all_day_price_cents: 0,
    unit_amount_cents: 0,
    location_id: 'sunset-somo',
    pricing_provenance: 'course_owned_equipment',
  };
  const pricedAllDay = await priceSunsetBookingServices(
    makePg(makeServices(freeAllDayMeta, 0)),
    'sunset',
    bookingId,
  );
  ok(
    'explicit free all_day CE also accepted',
    pricedAllDay && pricedAllDay.ok === true && pricedAllDay.total_cents === 3500,
    JSON.stringify(pricedAllDay),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Bug 2 — Today’s Prep exact offerings
// ─────────────────────────────────────────────────────────────────────────────
function bug2TodaysPrepExactOfferings() {
  section('Bug 2: Today’s Prep exact course add-on + top-2 other rentals');

  const cockpitSrc = read('scripts/browser/sunset-schedule-day-cockpit-ui.js');
  const doc = createMinimalDocument();
  const mount = doc.createElement('div');
  mount.id = 'ps-day-cockpit';
  doc.body.appendChild(mount);

  const sandbox = {
    console,
    module: { exports: {} },
    exports: {},
    document: doc,
    window: { document: doc },
    portalT(k) { return k; },
    el(id) { return doc.getElementById(id); },
    scheduleRowIsActive(r) {
      if (!r) return false;
      if (r._isCancelled || r.schedule_ghost) return false;
      const bs = String(r.booking_status || r.status || '').toLowerCase();
      if (bs === 'cancelled' || bs === 'canceled') return false;
      const ss = String(r.service_status || '').toLowerCase();
      if (ss === 'cancelled') return false;
      return true;
    },
    scheduleActiveDayIso: () => '2026-08-01',
    scheduleCurrentViewMode: () => 'day',
    scheduleGetRowsSnapshot: () => [],
    scheduleBuildDaySessions: () => [],
    scheduleDayEquipmentTotals: () => ({
      boards: { total: 0, lesson: 0, rental: 0 },
      wetsuits: { total: 0, lesson: 0, rental: 0 },
    }),
    scheduleUnpaidPendingCount: () => 0,
    getSunsetLocationLabel: () => 'Sunset Somo',
  };
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(cockpitSrc, sandbox, { filename: 'sunset-schedule-day-cockpit-ui.js' });
  const cockpit = sandbox.module.exports;

  ok(
    'exports scheduleBuildDayPrepItems (data-driven prep projection)',
    typeof cockpit.scheduleBuildDayPrepItems === 'function',
  );

  const buildPrep = cockpit.scheduleBuildDayPrepItems;
  const dateIso = '2026-08-01';
  const rows = [];
  for (let i = 1; i <= 4; i += 1) {
    rows.push({
      booking_id: `b-ce-${i}`,
      booking_code: `CE-${i}`,
      booking_status: 'confirmed',
      service_status: 'confirmed',
      service_date: dateIso,
      service_type: 'addon_service',
      quantity: 1,
      metadata: {
        course_equipment: true,
        course_equipment_mode: 'during_course',
        offering_key: 'surfboard_wetsuit',
        label: 'Surfboard + Wetsuit',
      },
    });
  }
  rows.push({
    booking_id: 'b-r1',
    booking_code: 'R1',
    booking_status: 'confirmed',
    service_status: 'confirmed',
    service_date: dateIso,
    service_type: 'addon_service',
    quantity: 3,
    metadata: {
      rental_offering: true,
      generic_rental: true,
      offering_key: 'kayak_rental',
      label: 'Kayak',
    },
  });
  rows.push({
    booking_id: 'b-r2',
    booking_code: 'R2',
    booking_status: 'confirmed',
    service_status: 'confirmed',
    service_date: dateIso,
    service_type: 'addon_service',
    quantity: 2,
    metadata: {
      rental_offering: true,
      generic_rental: true,
      offering_key: 'softboard',
      label: 'Softboard',
    },
  });
  rows.push({
    booking_id: 'b-r3',
    booking_code: 'R3',
    booking_status: 'confirmed',
    service_status: 'confirmed',
    service_date: dateIso,
    service_type: 'addon_service',
    quantity: 1,
    metadata: {
      rental_offering: true,
      generic_rental: true,
      offering_key: 'towel_rental',
      label: 'Towel',
    },
  });
  rows.push({
    booking_id: 'b-cancel',
    booking_code: 'CX',
    booking_status: 'cancelled',
    service_status: 'cancelled',
    service_date: dateIso,
    service_type: 'addon_service',
    quantity: 9,
    metadata: {
      course_equipment: true,
      offering_key: 'surfboard_wetsuit',
      label: 'Surfboard + Wetsuit',
    },
  });
  rows.push({
    booking_id: 'b-other-day',
    booking_code: 'OD',
    booking_status: 'confirmed',
    service_status: 'confirmed',
    service_date: '2026-08-02',
    service_type: 'addon_service',
    quantity: 5,
    metadata: {
      course_equipment: true,
      offering_key: 'surfboard_wetsuit',
      label: 'Surfboard + Wetsuit',
    },
  });

  const items = buildPrep(rows, dateIso);
  ok('prep items is array', Array.isArray(items), JSON.stringify(items));
  const ce = (items || []).find((it) => it && it.offering_key === 'surfboard_wetsuit');
  ok(
    'course add-on Surfboard + Wetsuit qty=4 first-class row',
    ce && Number(ce.quantity) === 4 && /Surfboard \+ Wetsuit/i.test(String(ce.label || '')),
    JSON.stringify(ce),
  );
  ok(
    'does not decompose combo into Surfboards/Wetsuits component rows',
    !(items || []).some((it) => /^(Surfboards?|Wetsuits?)$/i.test(String(it.label || ''))),
    JSON.stringify(items),
  );
  const others = (items || []).filter((it) => it && it.offering_key !== 'surfboard_wetsuit');
  ok('at most two other rental types after CE', others.length <= 2, JSON.stringify(others));
  ok(
    'top other rentals are Kayak(3) then Softboard(2); Towel(1) dropped',
    others.length === 2
      && others[0].offering_key === 'kayak_rental' && others[0].quantity === 3
      && others[1].offering_key === 'softboard' && others[1].quantity === 2,
    JSON.stringify(others),
  );
  ok(
    'CE rows sort before other rentals',
    items[0] && items[0].offering_key === 'surfboard_wetsuit',
    JSON.stringify(items.map((i) => i.offering_key)),
  );

  // Same exact offering key as course add-on AND standalone rental must aggregate
  // into one add-on-first row (4 CE + 2 standalone => qty 6), not drop standalone
  // demand or duplicate among "other rentals".
  const sameKeyRows = [];
  for (let i = 1; i <= 4; i += 1) {
    sameKeyRows.push({
      booking_id: `b-ce-agg-${i}`,
      booking_code: `CEA-${i}`,
      booking_status: 'confirmed',
      service_status: 'confirmed',
      service_date: dateIso,
      service_type: 'addon_service',
      quantity: 1,
      metadata: {
        course_equipment: true,
        course_equipment_mode: 'during_course',
        offering_key: 'surfboard_wetsuit',
        label: 'Surfboard + Wetsuit',
      },
    });
  }
  sameKeyRows.push({
    booking_id: 'b-stand-1',
    booking_code: 'ST1',
    booking_status: 'confirmed',
    service_status: 'confirmed',
    service_date: dateIso,
    service_type: 'addon_service',
    quantity: 2,
    metadata: {
      rental_offering: true,
      generic_rental: true,
      offering_key: 'surfboard_wetsuit',
      // Distinct rental label — CE booked label must win on the add-on-first row.
      label: 'Board/Suit Rental Alias',
    },
  });
  sameKeyRows.push({
    booking_id: 'b-r1-agg',
    booking_code: 'R1A',
    booking_status: 'confirmed',
    service_status: 'confirmed',
    service_date: dateIso,
    service_type: 'addon_service',
    quantity: 3,
    metadata: {
      rental_offering: true,
      generic_rental: true,
      offering_key: 'kayak_rental',
      label: 'Kayak',
    },
  });
  sameKeyRows.push({
    booking_id: 'b-r2-agg',
    booking_code: 'R2A',
    booking_status: 'confirmed',
    service_status: 'confirmed',
    service_date: dateIso,
    service_type: 'addon_service',
    quantity: 2,
    metadata: {
      rental_offering: true,
      generic_rental: true,
      offering_key: 'softboard',
      label: 'Softboard',
    },
  });
  sameKeyRows.push({
    booking_id: 'b-r3-agg',
    booking_code: 'R3A',
    booking_status: 'confirmed',
    service_status: 'confirmed',
    service_date: dateIso,
    service_type: 'addon_service',
    quantity: 1,
    metadata: {
      rental_offering: true,
      generic_rental: true,
      offering_key: 'towel_rental',
      label: 'Towel',
    },
  });
  // Leak guards: cancelled, off-day, ghost, and nonselected snapshot noise.
  sameKeyRows.push({
    booking_id: 'b-cancel-agg',
    booking_code: 'CXA',
    booking_status: 'cancelled',
    service_status: 'cancelled',
    service_date: dateIso,
    service_type: 'addon_service',
    quantity: 9,
    metadata: {
      course_equipment: true,
      offering_key: 'surfboard_wetsuit',
      label: 'Surfboard + Wetsuit',
    },
  });
  sameKeyRows.push({
    booking_id: 'b-ghost-agg',
    booking_code: 'GHA',
    booking_status: 'confirmed',
    service_status: 'confirmed',
    service_date: dateIso,
    service_type: 'addon_service',
    quantity: 7,
    schedule_ghost: true,
    metadata: {
      rental_offering: true,
      generic_rental: true,
      offering_key: 'surfboard_wetsuit',
      label: 'Surfboard + Wetsuit',
    },
  });
  sameKeyRows.push({
    booking_id: 'b-other-day-agg',
    booking_code: 'ODA',
    booking_status: 'confirmed',
    service_status: 'confirmed',
    service_date: '2026-08-02',
    service_type: 'addon_service',
    quantity: 5,
    metadata: {
      course_equipment: true,
      offering_key: 'surfboard_wetsuit',
      label: 'Surfboard + Wetsuit',
    },
  });
  sameKeyRows.push({
    booking_id: 'b-cross-loc',
    booking_code: 'XL',
    booking_status: 'confirmed',
    service_status: 'confirmed',
    service_date: dateIso,
    service_type: 'addon_service',
    quantity: 8,
    // Snapshot noise for a non-selected school — only appears if collection path
    // incorrectly merges unscoped rows (caller supplies selected snapshot).
    _exclude_from_selected_snapshot: true,
    metadata: {
      rental_offering: true,
      generic_rental: true,
      offering_key: 'kayak_rental',
      label: 'Kayak',
      location_id: 'sunset-other-school',
    },
  });

  const selectedSnapshot = sameKeyRows.filter((r) => !r._exclude_from_selected_snapshot);
  const aggItems = buildPrep(selectedSnapshot, dateIso);
  const aggCe = (aggItems || []).find((it) => it && it.offering_key === 'surfboard_wetsuit');
  ok(
    'same-key 4 CE + 2 standalone aggregates to one add-on-first row qty=6',
    aggCe && Number(aggCe.quantity) === 6 && aggCe.kind === 'course_addon',
    JSON.stringify(aggCe),
  );
  ok(
    'aggregated row keeps trusted course-add-on booked label (no rental alias / no decompose)',
    aggCe && String(aggCe.label) === 'Surfboard + Wetsuit'
      && !/Board\/Suit Rental Alias/i.test(String(aggCe.label || '')),
    JSON.stringify(aggCe),
  );
  const sameKeyAsOther = (aggItems || []).filter(
    (it) => it && it.offering_key === 'surfboard_wetsuit' && it.kind === 'rental',
  );
  ok(
    'same-key standalone is not duplicated among other rentals',
    sameKeyAsOther.length === 0,
    JSON.stringify(sameKeyAsOther),
  );
  const aggOthers = (aggItems || []).filter((it) => it && it.offering_key !== 'surfboard_wetsuit');
  ok(
    'after aggregate: top-2 OTHER rentals Kayak(3) then Softboard(2); Towel dropped',
    aggOthers.length === 2
      && aggOthers[0].offering_key === 'kayak_rental' && aggOthers[0].quantity === 3
      && aggOthers[1].offering_key === 'softboard' && aggOthers[1].quantity === 2,
    JSON.stringify(aggOthers),
  );
  ok(
    'cancelled/ghost/off-day demand does not inflate same-key total',
    aggCe && Number(aggCe.quantity) === 6,
    JSON.stringify(aggCe),
  );

  // Collection/projection path (not only final supplied prep data).
  sandbox.scheduleGetRowsSnapshot = () => selectedSnapshot;
  sandbox.scheduleActiveDayIso = () => dateIso;
  ok(
    'exports scheduleCollectDayCockpitSource',
    typeof cockpit.scheduleCollectDayCockpitSource === 'function',
  );
  const collected = cockpit.scheduleCollectDayCockpitSource();
  const collItems = collected && collected.prep && collected.prep.items;
  const collCe = (collItems || []).find((it) => it && it.offering_key === 'surfboard_wetsuit');
  ok(
    'collect path projects same-key aggregate qty=6',
    collCe && Number(collCe.quantity) === 6,
    JSON.stringify(collCe),
  );
  ok(
    'collect path ranks other rentals after CE aggregate',
    Array.isArray(collItems)
      && collItems[0] && collItems[0].offering_key === 'surfboard_wetsuit'
      && collItems.length === 3
      && collItems[1].offering_key === 'kayak_rental' && collItems[1].quantity === 3
      && collItems[2].offering_key === 'softboard' && collItems[2].quantity === 2,
    JSON.stringify(collItems),
  );

  const data = cockpit.scheduleBuildDayCockpitData({
    venue: 'Sunset Somo',
    date: dateIso,
    navMode: 'day',
    sessions: [],
    prep: { items: aggItems, unpaid: 1, needReply: 0 },
  });
  ok(
    'cockpit data carries prep.items',
    data && data.prep && Array.isArray(data.prep.items) && data.prep.items.length > 0,
    JSON.stringify(data && data.prep),
  );

  cockpit.scheduleRenderDayCockpit(mount, data);
  const text = mount.textContent || '';
  ok(
    'render shows exact CE label Surfboard + Wetsuit with aggregated qty 6',
    /Surfboard \+ Wetsuit/i.test(text) && /Surfboard \+ Wetsuit6|Surfboard \+ Wetsuit[\s\S]{0,8}6/i.test(text),
    text.slice(0, 500),
  );
  ok(
    'render does not hardcode Surfboards 0 / Wetsuits 0 as the primary prep truth',
    !( /Surfboards\s*0/i.test(text) && /Wetsuits\s*0/i.test(text) && !/Surfboard \+ Wetsuit/i.test(text) ),
    text.slice(0, 500),
  );
  ok(
    'render does not show rental alias for aggregated add-on-first row',
    !/Board\/Suit Rental Alias/i.test(text),
    text.slice(0, 500),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Bug 3 — rental commit new 2_days beside existing prices
// ─────────────────────────────────────────────────────────────────────────────
async function bug3RentalCommitNewDuration() {
  section('Bug 3: commit accepts new 2_days with existing 2_hours + 1_day');

  const {
    commitRentalEquipmentEdit,
    patchPriceRule,
  } = require('./lib/tenant-admin-writes');

  const state = {
    inTx: false,
    begun: 0,
    commits: 0,
    rollbacks: 0,
    savepoints: 0,
    offering: {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      client_slug: 'sunset',
      location_id: 'sunset-somo',
      offering_key: 'surfboard_wetsuit',
      label: 'Surfboard + Wetsuit',
      group_key: 'equipment',
      excludes: [],
      sort_order: 0,
      stock_quantity: 100,
      active: true,
      tenant_id: 'sunset',
      updated_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    },
    prices: [
      {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        client_slug: 'sunset',
        location_id: 'sunset-somo',
        item_type: 'rental',
        item_code: 'surfboard_wetsuit__2_hours',
        display_name: 'Surfboard + Wetsuit',
        currency: 'EUR',
        amount_cents: 1500,
        unit: 'session',
        active: true,
        tenant_id: 'sunset',
      },
      {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        client_slug: 'sunset',
        location_id: 'sunset-somo',
        item_type: 'rental',
        item_code: 'surfboard_wetsuit__1_day',
        display_name: 'Surfboard + Wetsuit',
        currency: 'EUR',
        amount_cents: 3000,
        unit: 'day',
        active: true,
        tenant_id: 'sunset',
      },
    ],
  };

  const client = {
    async query(sql, params = []) {
      const q = String(sql || '').replace(/\s+/g, ' ').trim();
      if (/^BEGIN$/i.test(q)) {
        state.inTx = true;
        state.begun += 1;
        return { rows: [] };
      }
      if (/^COMMIT$/i.test(q)) {
        state.inTx = false;
        state.commits += 1;
        return { rows: [] };
      }
      if (/^ROLLBACK$/i.test(q) && !/TO SAVEPOINT/i.test(q)) {
        state.inTx = false;
        state.rollbacks += 1;
        return { rows: [] };
      }
      if (/^SAVEPOINT /i.test(q)) {
        if (!state.inTx) {
          const err = new Error('SAVEPOINT can only be used in transaction blocks');
          err.code = '25P01';
          throw err;
        }
        state.savepoints += 1;
        return { rows: [] };
      }
      if (/ROLLBACK TO SAVEPOINT/i.test(q)) return { rows: [] };
      if (/pg_advisory_xact_lock/i.test(q)) return { rows: [] };
      if (/to_regclass/i.test(q)) return { rows: [{ reg: 'public.tenant_price_rules' }] };
      if (/information_schema\.tables/i.test(q)) {
        return {
          rows: [
            'tenant_price_rules',
            'tenant_lesson_capacity_rules',
            'tenant_lesson_time_rules',
            'tenant_config_audit_log',
          ].map((table_name) => ({ table_name })),
        };
      }
      if (/information_schema\.columns/i.test(q) || /column_name/i.test(q)) {
        return { rows: [{ column_name: 'location_id' }, { column_name: 'stock_quantity' }] };
      }
      if (/FROM tenant_rental_offerings/i.test(q) && /SELECT/i.test(q)) {
        if (/label/i.test(q) && !/ORDER BY active DESC/i.test(q)) return { rows: [] };
        return { rows: [{ ...state.offering }] };
      }
      if (/UPDATE tenant_rental_offerings/i.test(q)) {
        if (/SET active/i.test(q)) {
          state.offering.active = params[0];
          return { rows: [{ ...state.offering }] };
        }
        for (const p of params) {
          if (typeof p === 'string' && p.length < 80 && p !== 'surfboard_wetsuit'
            && p !== state.offering.id && p !== 'sunset' && p !== 'sunset-somo'
            && !/^[0-9a-f-]{36}$/i.test(p)) {
            state.offering.label = p;
          }
          if (Number.isInteger(p)) state.offering.stock_quantity = p;
        }
        return { rows: [{ ...state.offering }] };
      }
      if (/FROM tenant_price_rules/i.test(q) && /SELECT/i.test(q)) {
        if (/id = \$1/i.test(q) || (/WHERE id/i.test(q) && params[0])) {
          const id = params[0];
          const row = state.prices.find((r) => r.id === id);
          return { rows: row ? [{ ...row }] : [] };
        }
        const code = params.find((p) => typeof p === 'string' && String(p).includes('__'));
        const row = state.prices.find((r) => r.item_code === code);
        return { rows: row ? [{ ...row }] : [] };
      }
      if (/UPDATE tenant_price_rules/i.test(q)) {
        const id = params[0];
        const row = state.prices.find((r) => r.id === id);
        if (!row) return { rows: [] };
        for (const p of params) {
          if (Number.isInteger(p) && p > 100 && p < 1000000) row.amount_cents = p;
        }
        return { rows: [{ ...row }] };
      }
      if (/INSERT INTO tenant_price_rules/i.test(q)) {
        const code = params.find((p) => typeof p === 'string' && String(p).includes('__'));
        const existing = state.prices.find((r) => r.item_code === code);
        if (existing) {
          const cents = params.find((p) => Number.isInteger(p) && p >= 0 && p < 1000000);
          if (cents != null) existing.amount_cents = cents;
          return { rows: [{ ...existing }] };
        }
        const cents = params.find((p) => Number.isInteger(p) && p >= 0 && p < 1000000) || 0;
        const unit = params.find((p) => p === 'day' || p === 'session' || p === 'item') || 'day';
        const row = {
          id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          client_slug: 'sunset',
          location_id: 'sunset-somo',
          item_type: 'rental',
          item_code: code || 'surfboard_wetsuit__2_days',
          display_name: 'Surfboard + Wetsuit',
          currency: 'EUR',
          amount_cents: cents,
          unit,
          active: true,
          tenant_id: 'sunset',
        };
        state.prices.push(row);
        return { rows: [{ ...row }] };
      }
      if (/tenant_config_audit/i.test(q)) return { rows: [] };
      return { rows: [] };
    },
  };

  const body = {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offering_key: 'surfboard_wetsuit',
    label: 'Surfboard + Wetsuit',
    stock_quantity: 100,
    active: true,
    prices: [
      { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', amount_cents: 1500, period_window: '2_hours' },
      { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', amount_cents: 3000, period_window: '1_day' },
    ],
    new_prices: [{ period_window: '2_days', amount_cents: 4000 }],
    actor: { staff_user_id: null, email: 'op@example.com' },
  };

  let result;
  let threw = null;
  try {
    result = await commitRentalEquipmentEdit(client, body);
  } catch (err) {
    threw = err;
  }

  ok(
    'commit does not throw (no SAVEPOINT-outside-tx from premature COMMIT)',
    !threw,
    threw && (threw.stack || threw.message),
  );
  ok(
    'commit ok for new 2_days beside existing durations',
    result && result.ok === true && result.body && result.body.success === true,
    JSON.stringify(result),
  );
  const twoDays = state.prices.filter((p) => p.item_code === 'surfboard_wetsuit__2_days');
  ok('created exactly one 2_days price row', twoDays.length === 1 && twoDays[0].amount_cents === 4000, JSON.stringify(twoDays));
  ok(
    'preserved existing 2_hours and 1_day',
    state.prices.some((p) => p.item_code === 'surfboard_wetsuit__2_hours' && p.amount_cents === 1500)
      && state.prices.some((p) => p.item_code === 'surfboard_wetsuit__1_day' && p.amount_cents === 3000),
    JSON.stringify(state.prices.map((p) => [p.item_code, p.amount_cents])),
  );
  ok('single outer transaction committed', state.commits >= 1 && state.begun >= 1);

  const second = await commitRentalEquipmentEdit(client, body);
  ok('idempotent retry ok', second && second.ok === true, JSON.stringify(second));
  ok(
    'retry does not duplicate 2_days',
    state.prices.filter((p) => p.item_code === 'surfboard_wetsuit__2_days').length === 1,
  );

  const dup = await commitRentalEquipmentEdit(client, {
    ...body,
    new_prices: [
      { period_window: '3_days', amount_cents: 5000 },
      { period_window: '3_days', amount_cents: 5100 },
    ],
  });
  ok(
    'duplicate duration returns actionable 400 (not generic 500)',
    dup && dup.ok === false && dup.status === 400
      && /duplicate duration/i.test(String((dup.body && dup.body.error) || '')),
    JSON.stringify(dup),
  );

  const badAmt = await commitRentalEquipmentEdit(client, {
    ...body,
    new_prices: [{ period_window: '4_days', amount_cents: 0 }],
  });
  ok(
    'non-positive standalone rental price rejected with actionable error',
    badAmt && badAmt.ok === false && badAmt.status === 400
      && /amount_cents|positive|> 0/i.test(String((badAmt.body && badAmt.body.error) || '')),
    JSON.stringify(badAmt),
  );

  state.inTx = true;
  state.commits = 0;
  const patchRes = await patchPriceRule(client, {
    ruleId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    patch: { amount_cents: 1600 },
    actor: { email: 'op@example.com' },
    skipTransaction: true,
  });
  ok('patchPriceRule skipTransaction succeeds', patchRes && patchRes.ok === true, JSON.stringify(patchRes));
  ok(
    'patchPriceRule skipTransaction does not COMMIT',
    state.commits === 0 && state.inTx === true,
    `commits=${state.commits} inTx=${state.inTx}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Bug 4 — rental write error ownership / clear boundaries
// ─────────────────────────────────────────────────────────────────────────────
function bug4RentalWriteErrorOwnership() {
  section('Bug 4: rental write error local + cleared on nav/cancel/success');

  const adminSrc = read('scripts/browser/sunset-admin-ui.js');
  const apiSrc = read('scripts/staff-query-api.js');

  // Supplemental source ownership (never sole proof — behavioral suite below).
  ok(
    'equipment-only clear helper exists (adminClearEquipErrors)',
    /function adminClearEquipErrors\s*\(/.test(adminSrc),
  );
  ok(
    'adminShowEquipError does not clear shared #admin-save-msg before paint',
    /function adminShowEquipError[\s\S]*?\n\}/.test(adminSrc)
      && !/function adminShowEquipError[\s\S]{0,400}adminShowMessage\(\s*['"]['"]\s*,\s*['"]['"]\s*\)/.test(adminSrc)
      && !/function adminShowEquipError[\s\S]{0,400}adminClearWriteMessage\s*\(/.test(adminSrc),
  );
  ok(
    'save-equipment paints equipment-local error host',
    /data-admin-equip-error/.test(adminSrc)
      && /adminShowEquipError\(seKey/.test(adminSrc),
  );
  ok(
    'cancel-edit / subtab / load / render use equipment-only clear',
    /action === 'cancel-edit'[\s\S]{0,350}adminClearEquipErrors/.test(adminSrc)
      && /function adminSelectSubTab[\s\S]{0,500}adminClearEquipErrors/.test(adminSrc)
      && /function loadAdminTab[\s\S]{0,500}adminClearEquipErrors/.test(adminSrc)
      && /function renderAdminFromConfig[\s\S]{0,700}adminClearEquipErrors/.test(adminSrc),
  );
  ok(
    'save-equipment success clears equip error without dual-clear helper wiping globals first',
    /save-equipment[\s\S]{0,2800}adminClearEquipErrors[\s\S]{0,500}adminShowMessage\(\s*['"]success['"]/.test(adminSrc)
      || /save-equipment[\s\S]{0,2800}adminShowMessage\(\s*['"]success['"]/.test(adminSrc),
  );
  ok(
    'client-change boundary clears equipment-local errors only',
    /c-client[\s\S]{0,500}addEventListener\(\s*['"]change['"][\s\S]{0,600}adminClearEquipErrors/.test(apiSrc)
      || /clientSelectEl\.addEventListener\(\s*['"]change['"][\s\S]{0,600}adminClearEquipErrors/.test(apiSrc),
  );
  // The character window is a proximity heuristic, not a budget — switchToTab keeps
  // growing as tenants are added. The `prevTab === 'admin'` check below is what
  // actually pins the clear to the leave-Admin branch.
  ok(
    'top-level switchToTab clears equipment errors when leaving Admin',
    /function switchToTab[\s\S]{0,4000}adminClearEquipErrors/.test(apiSrc)
      && /prevTab === 'admin'[\s\S]{0,120}adminClearEquipErrors/.test(apiSrc),
  );

  const bannerIds = (apiSrc.match(/id="admin-save-msg"/g) || []).length;
  ok('single admin-save-msg host in staff UI shell', bannerIds === 1, String(bannerIds));

  // ── Behavioral harness: production helpers + real event dispatch ──────────
  const doc = createMinimalDocument();
  const UNRELATED = 'Unrelated finance notice — keep me';

  function paintUnrelatedGlobal(msg) {
    const box = doc.getElementById('admin-save-msg');
    box.className = 'state-msg portal-admin-save-msg error';
    box.style.display = 'block';
    box.textContent = msg || UNRELATED;
  }
  function assertGlobalUnchanged(label, expected) {
    const box = doc.getElementById('admin-save-msg');
    ok(
      label,
      box
        && box.textContent === (expected || UNRELATED)
        && box.style.display === 'block',
      `global="${box && box.textContent}" display=${box && box.style.display}`,
    );
  }
  function paintEquipError(text) {
    const host = doc.getElementById('admin-equip-error-surfboard_wetsuit');
    host.className = 'state-msg portal-admin-equip-error error';
    host.style.display = 'block';
    host.textContent = text || 'rental write failed';
  }
  function equipVisible() {
    const host = doc.getElementById('admin-equip-error-surfboard_wetsuit');
    return !!(host && host.textContent && host.style.display !== 'none');
  }
  function equipCleared() {
    const host = doc.getElementById('admin-equip-error-surfboard_wetsuit');
    return !host || !host.textContent || host.style.display === 'none';
  }

  // Shell: global banner + Admin tab panel + equip card error host + cancel + subtabs + client select + non-admin tab.
  const globalMsg = doc.createElement('div');
  globalMsg.id = 'admin-save-msg';
  globalMsg.className = 'state-msg portal-admin-save-msg';
  globalMsg.style.display = 'none';
  doc.body.appendChild(globalMsg);

  const tabAdmin = doc.createElement('div');
  tabAdmin.id = 'tab-admin';
  tabAdmin.className = 'tab-panel active';
  doc.body.appendChild(tabAdmin);

  const tabHome = doc.createElement('div');
  tabHome.id = 'tab-portal-home';
  tabHome.className = 'tab-panel';
  doc.body.appendChild(tabHome);

  const tabBtnAdmin = doc.createElement('button');
  tabBtnAdmin.className = 'tab-btn active';
  tabBtnAdmin.setAttribute('data-tab', 'admin');
  doc.body.appendChild(tabBtnAdmin);
  const tabBtnHome = doc.createElement('button');
  tabBtnHome.className = 'tab-btn';
  tabBtnHome.setAttribute('data-tab', 'portal-home');
  doc.body.appendChild(tabBtnHome);

  const subList = doc.createElement('div');
  subList.id = 'admin-subtab-list';
  subList.setAttribute('role', 'tablist');
  subList.className = 'portal-admin-subtabs';
  tabAdmin.appendChild(subList);
  const subFin = doc.createElement('button');
  subFin.setAttribute('role', 'tab');
  subFin.setAttribute('data-admin-tab', 'finance');
  subFin.setAttribute('aria-selected', 'false');
  subFin.className = 'portal-admin-subtab';
  subList.appendChild(subFin);
  const subPr = doc.createElement('button');
  subPr.setAttribute('role', 'tab');
  subPr.setAttribute('data-admin-tab', 'pricing');
  subPr.setAttribute('aria-selected', 'true');
  subPr.className = 'portal-admin-subtab is-selected';
  subList.appendChild(subPr);

  const finPanel = doc.createElement('div');
  finPanel.id = 'admin-panel-finance';
  finPanel.setAttribute('hidden', '');
  tabAdmin.appendChild(finPanel);
  const prPanel = doc.createElement('div');
  prPanel.id = 'admin-panel-pricing';
  tabAdmin.appendChild(prPanel);

  const equipCard = doc.createElement('div');
  equipCard.setAttribute('data-admin-equip', 'surfboard_wetsuit');
  prPanel.appendChild(equipCard);
  const equipErr = doc.createElement('div');
  equipErr.id = 'admin-equip-error-surfboard_wetsuit';
  equipErr.setAttribute('data-admin-equip-error', 'surfboard_wetsuit');
  equipErr.className = 'state-msg portal-admin-equip-error';
  equipErr.style.display = 'none';
  equipCard.appendChild(equipErr);

  const cancelBtn = doc.createElement('button');
  cancelBtn.setAttribute('data-admin-action', 'cancel-edit');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  equipCard.appendChild(cancelBtn);

  const saveBtn = doc.createElement('button');
  saveBtn.setAttribute('data-admin-action', 'save-equipment');
  saveBtn.setAttribute('data-equip-key', 'surfboard_wetsuit');
  saveBtn.type = 'button';
  saveBtn.textContent = 'Save';
  equipCard.appendChild(saveBtn);

  const clientSel = doc.createElement('select');
  clientSel.id = 'c-client';
  clientSel.value = 'sunset';
  doc.body.appendChild(clientSel);

  // Extract production admin message helpers + subtab select/wire + cancel path pieces.
  const helperExtract = adminSrc.slice(
    adminSrc.indexOf('function adminShowMessage'),
    adminSrc.indexOf('function adminEurosFromAmount'),
  );
  ok('extracted admin message helpers', /function adminClearEquipErrors/.test(helperExtract)
    && /function adminShowEquipError/.test(helperExtract));

  // Extract adminSelectSubTab + wireAdminSubTabs (production listeners).
  const selectStart = adminSrc.indexOf('function adminSelectSubTab');
  const wireStart = adminSrc.indexOf('function wireAdminSubTabs');
  const wireEnd = adminSrc.indexOf('function loadAdminTab', wireStart);
  const subtabExtract = adminSrc.slice(selectStart, wireEnd);
  ok('extracted adminSelectSubTab + wireAdminSubTabs', /function wireAdminSubTabs/.test(subtabExtract));

  // Extract the live cancel-edit / save-equipment success clear calls from production.
  const cancelBranch = adminSrc.match(
    /if \(action === 'cancel-edit'\)\{[\s\S]*?return;\s*\}/,
  );
  ok('extracted production cancel-edit branch', !!(cancelBranch && cancelBranch[0]));
  const saveSuccessClear = adminSrc.match(
    /adminClear(?:EquipErrors|WriteMessage)\(\);\s*\n\s*adminShowMessage\(\s*['"]success['"]/,
  );
  // Fresh render uses production renderAdminFromConfig clear call site pattern.
  const renderClearMatch = adminSrc.match(
    /function renderAdminFromConfig\(cfg, opts\)\{[\s\S]{0,500}adminClear(?:EquipErrors|WriteMessage)\s*\(/,
  );
  ok('extracted renderAdminFromConfig clear call', !!(renderClearMatch && renderClearMatch[0]));
  const renderUsesEquipOnly = /function renderAdminFromConfig[\s\S]{0,500}adminClearEquipErrors\s*\(/.test(adminSrc);
  const saveSuccessUsesEquipOnly = /adminClearEquipErrors\(\);\s*\n\s*adminShowMessage\(\s*['"]success['"]/.test(adminSrc);

  // Production-shaped save-equipment success + fresh render (exact helper names from source).
  const saveSnippet = [
    'function simulateSaveEquipmentFailure(key, msg){ adminShowEquipError(key, msg); }',
    'function simulateSaveEquipmentSuccess(key){',
    saveSuccessUsesEquipOnly
      ? "  adminClearEquipErrors(); adminShowMessage('success', 'Saved.');"
      : "  adminClearWriteMessage(); adminShowMessage('success', 'Saved.');",
    '}',
    'function simulateFreshRenderClear(){',
    renderUsesEquipOnly ? '  adminClearEquipErrors();' : '  adminClearWriteMessage();',
    '}',
  ].join('\n');
  void saveSuccessClear;

  // Production switchToTab + client change (extracted, with loadAdminTab stubbed).
  const switchMatch = apiSrc.match(/function switchToTab\(tab, subtab\)\{[\s\S]*?\nfunction switchToTabOnly/);
  ok('extracted production switchToTab', !!(switchMatch && switchMatch[0]));
  const switchSrc = switchMatch
    ? switchMatch[0].replace(/\nfunction switchToTabOnly[\s\S]*$/, '')
    : '';

  const clientMatch = apiSrc.match(
    /var clientSelectEl = el\('c-client'\);\s*if \(clientSelectEl\)\{\s*clientSelectEl\.addEventListener\('change', function\(\)\{[\s\S]*?\n  \}\);\s*\}/,
  );
  ok('extracted production #c-client change listener', !!(clientMatch && clientMatch[0]));

  // Keep cancel branch from calling undefined helpers: only the clear + editTarget reset.
  const cancelBody = cancelBranch
    ? cancelBranch[0]
      .replace(/renderAdminFromConfig\(cfg\);\s*/g, '')
    : "if (action === 'cancel-edit'){ if (typeof adminClearWriteMessage === 'function') adminClearWriteMessage(); return; }";

  const sb = {
    document: doc,
    window: { document: doc, __closeStaffNavMenu: null, __syncNavQuickFlip: null },
    console,
    localStorage: { _m: Object.create(null), setItem(k, v) { this._m[k] = String(v); }, getItem(k) { return this._m[k] || null; } },
    el(id) { return doc.getElementById(id); },
    getClient() { return (doc.getElementById('c-client') && doc.getElementById('c-client').value) || 'sunset'; },
    getPortalProfile() {
      return { is_surf_vertical: true, default_tab: 'portal-home' };
    },
    isTabHiddenForClient() { return false; },
    syncSunsetSchoolSwitcher() {},
    syncBcClientFromInbox() {},
    applyClientPortalProfile() {},
    loadDaySchedule() {},
    loadInbox() {},
    loadAdminTab() {
      // Production re-entry still clears equipment-local errors.
      if (typeof sb.adminClearEquipErrors === 'function') sb.adminClearEquipErrors();
      else if (typeof sb.adminClearWriteMessage === 'function') sb.adminClearWriteMessage();
    },
    // Sunset harness: lodging Admin shell is off, so Admin entry takes the surf path
    // and no top-level tab is redirected into an Admin sub-tab.
    portalIsLodgingAdmin() { return false; },
    portalRedirectNestedAdminTab() { return false; },
    openAdminTabForCurrentClient(opts) {
      sb.loadAdminTab(opts);
    },
    loadAdminFinanceForCurrentScope() {},
    loadMessageEvents() {},
    setInboxFilter() {},
    ensureInboxLoadedForTab() {},
    startInboxLivePolling() {},
    stopInboxLivePolling() {},
    wireLunaStaffTabCards() {},
    wireInboxLeftListWheel() {},
    wirePortalHomeScheduleControls() {},
    loadPortalHome() {},
    loadCustomersTab() {},
    loadServicesTab() {},
    toOnTourOperatorTabOpen() {},
    hideInboxMobileThread() {},
    staffNotificationSettingsApplyVisibility() {},
    bcOnBedCalendarTabOpen() {},
    dsTodayIso() { return '2026-08-01'; },
    adminActiveSubTab: 'pricing',
    adminConfigCache: { prices: [] },
    adminEditTarget: 'equip:surfboard_wetsuit',
    adminSaveBusy: false,
    portalT(k) { return k; },
    // Production cancel-edit calls renderAdminFromConfig after clear — stub keeps
    // banner/equip hosts intact so lifecycle ownership is observable.
    renderAdminFromConfig() {},
    renderAdminWriteState() {},
    renderAdminSchoolContext() {},
    renderAdminSectionLessonTimesFromConfig() {},
    renderAdminSectionPricesFromConfig() {},
    renderAdminSectionAccommodationFromConfig() {},
    adminSnapshotPricingDraftState() {},
    adminClearPricingDraftState() {},
    adminRestorePricingDraftState() {},
  };
  sb.global = sb;
  sb.globalThis = sb;
  sb.window = Object.assign(sb.window, sb);

  const cancelSnippet = [
    'function wireAdminCancelEditForTest(){',
    "  var root = el('tab-admin');",
    "  if (!root || root.dataset.adminWiredCancel === '1') return;",
    "  root.dataset.adminWiredCancel = '1';",
    "  root.addEventListener('click', function(ev){",
    "    var btn = ev.target && ev.target.closest ? ev.target.closest('[data-admin-action]') : null;",
    '    if (!btn || adminSaveBusy) return;',
    "    var action = btn.getAttribute('data-admin-action');",
    '    var cfg = adminConfigCache;',
    `    ${cancelBody}`,
    '  });',
    '}',
  ].join('\n');

  const boot = [
    helperExtract,
    subtabExtract,
    cancelSnippet,
    saveSnippet,
    switchSrc,
    clientMatch ? clientMatch[0] : '',
    'wireAdminCancelEditForTest();',
    'wireAdminSubTabs();',
    'this.adminShowMessage = adminShowMessage;',
    'this.adminShowEquipError = adminShowEquipError;',
    "this.adminClearEquipErrors = typeof adminClearEquipErrors === 'function' ? adminClearEquipErrors : null;",
    "this.adminClearWriteMessage = typeof adminClearWriteMessage === 'function' ? adminClearWriteMessage : null;",
    'this.adminSelectSubTab = adminSelectSubTab;',
    "this.switchToTab = typeof switchToTab === 'function' ? switchToTab : null;",
    'this.simulateSaveEquipmentFailure = simulateSaveEquipmentFailure;',
    'this.simulateSaveEquipmentSuccess = simulateSaveEquipmentSuccess;',
    'this.simulateFreshRenderClear = simulateFreshRenderClear;',
  ].join('\n');
  try {
    vm.runInNewContext(boot, sb);
  } catch (err) {
    ok('boot production admin/switch listeners in harness', false, err && (err.stack || err.message));
    return;
  }
  ok('boot production admin/switch listeners in harness', true);

  // 1) Paint equipment error must not erase unrelated global banner.
  paintUnrelatedGlobal(UNRELATED);
  sb.adminShowEquipError('surfboard_wetsuit', 'rental write failed');
  ok(
    'rental save failure paints only local equip host',
    equipVisible()
      && /rental write failed/i.test(doc.getElementById('admin-equip-error-surfboard_wetsuit').textContent),
    doc.getElementById('admin-equip-error-surfboard_wetsuit').textContent,
  );
  assertGlobalUnchanged('painting equip error leaves unrelated #admin-save-msg unchanged', UNRELATED);

  // 2) Cancel-edit click through production listener clears equip only.
  paintEquipError('rental write failed');
  paintUnrelatedGlobal(UNRELATED);
  cancelBtn.dispatchEvent({
    type: 'click',
    target: cancelBtn,
    preventDefault() { this.defaultPrevented = true; },
    defaultPrevented: false,
  });
  // Bubble to tab-admin (production listens on root).
  tabAdmin.dispatchEvent({
    type: 'click',
    target: cancelBtn,
    preventDefault() { this.defaultPrevented = true; },
    defaultPrevented: false,
  });
  ok('cancel-edit clears equipment-local error', equipCleared());
  assertGlobalUnchanged('cancel-edit leaves unrelated #admin-save-msg unchanged', UNRELATED);

  function safeStep(label, fn) {
    try {
      fn();
    } catch (err) {
      ok(label, false, err && (err.stack || err.message));
    }
  }

  // 3) Admin subtab click clears equip only.
  safeStep('Admin subtab change lifecycle', () => {
    paintEquipError('rental write failed');
    paintUnrelatedGlobal(UNRELATED);
    subList.dispatchEvent({
      type: 'click',
      target: subFin,
      preventDefault() { this.defaultPrevented = true; },
      defaultPrevented: false,
    });
    ok('Admin subtab change clears equipment-local error', equipCleared());
    assertGlobalUnchanged('Admin subtab change leaves unrelated #admin-save-msg unchanged', UNRELATED);
  });

  // 4) Top-level switch away from Admin clears equip only.
  safeStep('top-level leave Admin lifecycle', () => {
    paintEquipError('rental write failed');
    paintUnrelatedGlobal(UNRELATED);
    tabAdmin.className = 'tab-panel active';
    tabHome.className = 'tab-panel';
    tabBtnAdmin.className = 'tab-btn active';
    if (typeof sb.switchToTab === 'function') {
      sb.switchToTab('portal-home', null);
    }
    ok('top-level leave Admin clears equipment-local error', equipCleared());
    assertGlobalUnchanged('top-level leave Admin leaves unrelated #admin-save-msg unchanged', UNRELATED);

    // Re-entry stays clean (loadAdminTab stub clears equip).
    paintEquipError('stale after leave');
    if (typeof sb.switchToTab === 'function') sb.switchToTab('admin', null);
    ok('re-entry Admin clears stale equipment-local error', equipCleared());
    assertGlobalUnchanged('re-entry Admin leaves unrelated #admin-save-msg unchanged', UNRELATED);
  });

  // 5) Client selector change clears equip only while Admin remains active.
  safeStep('client selector change lifecycle', () => {
    tabAdmin.className = 'tab-panel active';
    tabHome.className = 'tab-panel';
    paintEquipError('rental write failed');
    paintUnrelatedGlobal(UNRELATED);
    clientSel.value = 'other-client';
    clientSel.dispatchEvent({
      type: 'change',
      target: clientSel,
      preventDefault() { this.defaultPrevented = true; },
      defaultPrevented: false,
    });
    ok('client selector change clears equipment-local error', equipCleared());
    assertGlobalUnchanged('client change leaves unrelated #admin-save-msg unchanged', UNRELATED);
  });

  // 6) Successful retry clears equip error; may own global with success notice.
  safeStep('successful retry lifecycle', () => {
    paintEquipError('rental write failed');
    paintUnrelatedGlobal(UNRELATED);
    sb.simulateSaveEquipmentSuccess('surfboard_wetsuit');
    ok('successful retry clears equipment-local error', equipCleared());
    ok(
      'successful save may replace global with its own success (operation-owned)',
      /Saved/i.test(doc.getElementById('admin-save-msg').textContent)
        || doc.getElementById('admin-save-msg').textContent === UNRELATED,
      doc.getElementById('admin-save-msg').textContent,
    );
  });

  // 7) Fresh render/load clears equip only (not unrelated global).
  safeStep('fresh render/load lifecycle', () => {
    paintEquipError('rental write failed');
    paintUnrelatedGlobal(UNRELATED);
    sb.simulateFreshRenderClear();
    ok('fresh render/load clears equipment-local error', equipCleared());
    assertGlobalUnchanged('fresh render/load leaves unrelated #admin-save-msg unchanged', UNRELATED);
  });

  // 8) Equipment-only clear helper never touches global (direct API).
  safeStep('adminClearEquipErrors direct API', () => {
    paintEquipError('rental write failed');
    paintUnrelatedGlobal(UNRELATED);
    ok('adminClearEquipErrors available for lifecycle', typeof sb.adminClearEquipErrors === 'function');
    if (typeof sb.adminClearEquipErrors === 'function') {
      sb.adminClearEquipErrors();
      ok('adminClearEquipErrors clears local host', equipCleared());
      assertGlobalUnchanged('adminClearEquipErrors does not touch #admin-save-msg', UNRELATED);
    }
    sb.adminShowEquipError('surfboard_wetsuit', 'commit failed: duplicate duration');
    ok(
      'retry failure paints local equip host again',
      /duplicate duration/i.test(doc.getElementById('admin-equip-error-surfboard_wetsuit').textContent),
    );
    assertGlobalUnchanged('retry failure paint still preserves unrelated global', UNRELATED);
  });
}

async function main() {
  console.log('verify-sunset-four-bug-batch\n');
  await bug1FreeAddonPaymentLink();
  bug2TodaysPrepExactOfferings();
  await bug3RentalCommitNewDuration();
  bug4RentalWriteErrorOwnership();

  if (failed) {
    console.error(`\nFAILED: ${failed} assertion(s)`);
    process.exit(1);
  }
  console.log('\nALL PASS');
}

main().catch((err) => {
  console.error('\nFATAL:', err && err.stack ? err.stack : err);
  process.exit(1);
});
